import sdk from "matrix-js-sdk";
import { Config } from "./config.js";
import { CallSession, IceServer } from "./webrtc/call-session.js";
import { CallInvite, sendAnswer, sendCandidates, sendHangup } from "./matrix/call-signaling.js";
import { fetchTurnCredentials, turnToIceServers } from "./matrix/turn.js";
import { VoicePipeline } from "./voice-pipeline.js";
import { logger } from "./logger.js";

const TAG = "call-manager";
const ICE_BATCH_DELAY_MS = 2000;

export class CallManager {
  private activeCalls = new Map<string, CallSession>();
  private voicePipelines = new Map<string, VoicePipeline>();
  private iceServers: IceServer[] = [];
  private iceRefreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private config: Config) {}

  async init(client: sdk.MatrixClient): Promise<void> {
    await this.refreshTurnCredentials(client);

    // Refresh TURN credentials periodically (every 10 min or per TTL)
    this.iceRefreshTimer = setInterval(
      () => this.refreshTurnCredentials(client),
      600_000
    );
  }

  private async refreshTurnCredentials(client: sdk.MatrixClient): Promise<void> {
    try {
      const creds = await fetchTurnCredentials(client);
      this.iceServers = turnToIceServers(creds);
      logger.info(TAG, `Refreshed TURN credentials (${this.iceServers.length} servers)`);
    } catch (err) {
      logger.error(TAG, "Failed to fetch TURN credentials", err);
    }
  }

  private get voicePipelineEnabled(): boolean {
    return !!(this.config.openai.apiKey && this.config.elevenlabs.apiKey && this.config.elevenlabs.voiceId);
  }

  async handleInvite(
    client: sdk.MatrixClient,
    invite: CallInvite
  ): Promise<void> {
    // Check concurrent call limit
    if (this.activeCalls.size >= this.config.calls.maxConcurrent) {
      logger.warn(TAG, `Rejecting call ${invite.callId}: max concurrent calls reached`);
      await sendHangup(client, invite.roomId, invite.callId, "user_busy");
      return;
    }

    // Check for duplicate
    if (this.activeCalls.has(invite.callId)) {
      logger.warn(TAG, `Duplicate invite for ${invite.callId}, ignoring`);
      return;
    }

    const session = new CallSession(
      invite.callId,
      invite.roomId,
      invite.sender,
      invite.partyId,
      this.iceServers,
      this.config.pipewire.sttSink,
      this.config.pipewire.ttsSource,
      this.config.calls.timeoutMs
    );

    // Batch local ICE candidates (Matrix spec: 2s batching window)
    let candidateBatch: Array<{ candidate: string; sdpMLineIndex: number; sdpMid: string }> = [];
    let batchTimer: ReturnType<typeof setTimeout> | null = null;

    session.onLocalCandidate = (candidate) => {
      candidateBatch.push(candidate);
      if (!batchTimer) {
        batchTimer = setTimeout(async () => {
          const batch = candidateBatch;
          candidateBatch = [];
          batchTimer = null;
          try {
            await sendCandidates(
              client,
              invite.roomId,
              invite.callId,
              this.config.matrix.deviceName,
              batch
            );
          } catch (err) {
            logger.error(TAG, "Failed to send ICE candidates", err);
          }
        }, ICE_BATCH_DELAY_MS);
      }
    };

    session.onHangup = async (callId) => {
      // Stop voice pipeline for this call
      const pipeline = this.voicePipelines.get(callId);
      if (pipeline) {
        pipeline.stop();
        this.voicePipelines.delete(callId);
        logger.info(TAG, `Voice pipeline stopped for ${callId}`);
      }

      this.activeCalls.delete(callId);
      if (batchTimer) clearTimeout(batchTimer);
      try {
        await sendHangup(client, invite.roomId, callId);
      } catch {
        // Best effort
      }
      logger.info(TAG, `Call ${callId} removed. Active calls: ${this.activeCalls.size}`);
    };

    this.activeCalls.set(invite.callId, session);
    logger.info(TAG, `Attempting to answer call ${invite.callId} from ${invite.sender}`);

    try {
      const answerSdp = await session.answer(invite.offerSdp);
      logger.info(TAG, `Got answer SDP for ${invite.callId}, sending to Matrix`);
      await sendAnswer(
        client,
        invite.roomId,
        invite.callId,
        this.config.matrix.deviceName,
        answerSdp
      );
      logger.info(TAG, `Call ${invite.callId} answered successfully`);

      // Start voice pipeline (STT → Agent → TTS) if configured
      if (this.voicePipelineEnabled) {
        try {
          const pipeline = new VoicePipeline(
            this.config,
            client,
            invite.roomId,
            invite.sender
          );
          await pipeline.start();
          this.voicePipelines.set(invite.callId, pipeline);
          logger.info(TAG, `Voice pipeline started for ${invite.callId}`);
        } catch (err: any) {
          logger.error(TAG, `Failed to start voice pipeline: ${err.message}`);
          // Call still works, just no STT/TTS
        }
      } else {
        logger.warn(TAG, "Voice pipeline disabled — missing OPENAI_API_KEY, ELEVENLABS_API_KEY, or ELEVENLABS_VOICE_ID");
      }
    } catch (err: any) {
      logger.error(TAG, `Failed to answer call ${invite.callId}: ${err?.message || err}`);
      logger.error(TAG, `Stack: ${err?.stack || "no stack"}`);
      this.activeCalls.delete(invite.callId);
      session.hangup();
      try {
        await sendHangup(client, invite.roomId, invite.callId, "unknown_error");
      } catch (hangupErr: any) {
        logger.error(TAG, `Failed to send hangup: ${hangupErr?.message}`);
      }
    }
  }

  handleRemoteCandidates(
    callId: string,
    candidates: Array<{ candidate: string; sdpMLineIndex: number; sdpMid: string }>
  ): void {
    const session = this.activeCalls.get(callId);
    if (!session) {
      logger.debug(TAG, `Candidates for unknown call ${callId}`);
      return;
    }

    for (const c of candidates) {
      session.addRemoteCandidate(c).catch((err) => {
        logger.warn(TAG, `Failed to add ICE candidate for ${callId}`, err);
      });
    }
  }

  handleRemoteHangup(callId: string): void {
    const session = this.activeCalls.get(callId);
    if (!session) return;

    // Stop voice pipeline
    const pipeline = this.voicePipelines.get(callId);
    if (pipeline) {
      pipeline.stop();
      this.voicePipelines.delete(callId);
    }

    session.hangup();
    this.activeCalls.delete(callId);
    logger.info(TAG, `Call ${callId} ended by remote. Active calls: ${this.activeCalls.size}`);
  }

  shutdown(): void {
    if (this.iceRefreshTimer) {
      clearInterval(this.iceRefreshTimer);
    }

    // Stop all voice pipelines
    for (const [callId, pipeline] of this.voicePipelines) {
      pipeline.stop();
    }
    this.voicePipelines.clear();

    for (const [callId, session] of this.activeCalls) {
      logger.info(TAG, `Shutting down call ${callId}`);
      session.hangup();
    }
    this.activeCalls.clear();
  }

  get activeCallCount(): number {
    return this.activeCalls.size;
  }
}
