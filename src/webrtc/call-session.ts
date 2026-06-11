import {
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
  RtpPacket,
  useAbsSendTime,
  useSdesMid,
  type RTCRtpTransceiver,
} from "werift";
import { AudioBridge } from "../audio/audio-bridge.js";
import {
  VideoFrameSampler,
  type VideoSamplerConfig,
  type VideoFrameSource,
} from "../video/frame-sampler.js";
import { logger } from "../logger.js";

const TAG = "call-session";

export type CallState =
  | "idle"
  | "invite-received"
  | "answering"
  | "active"
  | "hangup";

export interface IceServer {
  urls: string;
  username: string;
  credential: string;
}

export class CallSession {
  readonly callId: string;
  readonly roomId: string;
  readonly remoteSender: string;
  readonly remotePartyId: string;

  state: CallState = "idle";

  private pc: RTCPeerConnection | null = null;
  private audioBridge: AudioBridge | null = null;
  private videoSampler: VideoFrameSampler | null = null;
  private videoTransceiver: RTCRtpTransceiver | null = null;
  private pendingCandidates: RTCIceCandidate[] = [];
  private timeout: ReturnType<typeof setTimeout> | null = null;

  onLocalCandidate?: (candidate: {
    candidate: string;
    sdpMLineIndex: number;
    sdpMid: string;
  }) => void;

  onHangup?: (callId: string) => void;

  constructor(
    callId: string,
    roomId: string,
    remoteSender: string,
    remotePartyId: string,
    private iceServers: IceServer[],
    private sttSink: string,
    private ttsSource: string,
    private callTimeoutMs: number,
    private videoConfig?: VideoSamplerConfig
  ) {
    this.callId = callId;
    this.roomId = roomId;
    this.remoteSender = remoteSender;
    this.remotePartyId = remotePartyId;
  }

  async answer(offerSdp: string): Promise<string> {
    this.state = "answering";

    this.pc = new RTCPeerConnection({
      iceServers: this.iceServers.map((s) => ({
        urls: s.urls,
        username: s.username,
        credential: s.credential,
      })),
      headerExtensions: {
        audio: [useSdesMid(), useAbsSendTime()],
      },
    });

    // Create a local audio transceiver for send+recv
    const transceiver = this.pc.addTransceiver("audio", {
      direction: "sendrecv",
    });

    // Accept the caller's camera only when the offer actually carries a video
    // m-line — voice-only offers take the exact same path as before. Holding
    // the transceiver gives us receiver.sendRtcpPLI for keyframe requests.
    const offerHasVideo = /^m=video\s/m.test(offerSdp);
    if (offerHasVideo && this.videoConfig?.enabled) {
      this.videoTransceiver = this.pc.addTransceiver("video", {
        direction: "recvonly",
      });
      logger.info(TAG, "Offer contains video — added recvonly video transceiver");
    }

    // Handle remote tracks. werift's onTrack emits MediaStreamTrack directly,
    // once per sending remote m-line — a video call fires this twice. Video
    // must never reach the audio bridge (it would feed VP8 to the Opus
    // decoder and double-drive the audio sender).
    this.pc.onTrack.subscribe((mediaTrack: any) => {
      const track = mediaTrack.track ?? mediaTrack;
      const kind = track.kind ?? "audio";
      logger.info(TAG, `Remote track received: ${kind}`);
      if (kind === "video") {
        this.startVideoSampler(track);
        return;
      }
      this.startAudioBridge(
        track,
        (pkt: RtpPacket) => transceiver.sender.sendRtp(pkt)
      );
    });

    // Forward local ICE candidates
    this.pc.onIceCandidate.subscribe((candidate) => {
      if (candidate && this.onLocalCandidate) {
        this.onLocalCandidate({
          candidate: candidate.candidate,
          sdpMLineIndex: candidate.sdpMLineIndex ?? 0,
          sdpMid: candidate.sdpMid ?? "0",
        });
      }
    });

    // Monitor ICE connection state
    this.pc.iceConnectionStateChange.subscribe((state) => {
      logger.info(TAG, `ICE connection state: ${state}`);
      if (state === "disconnected" || state === "failed") {
        logger.warn(TAG, `ICE ${state}, hanging up`);
        this.hangup();
      }
    });

    // Set remote offer
    await this.pc.setRemoteDescription(
      new RTCSessionDescription(offerSdp, "offer")
    );

    // Add any candidates that arrived before the offer was set
    for (const candidate of this.pendingCandidates) {
      await this.pc.addIceCandidate(candidate);
    }
    this.pendingCandidates = [];

    // Create and set local answer
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);

    this.state = "active";

    // Set call timeout
    this.timeout = setTimeout(() => {
      logger.warn(TAG, `Call ${this.callId} timed out after ${this.callTimeoutMs}ms`);
      this.hangup();
    }, this.callTimeoutMs);

    logger.info(TAG, `Call ${this.callId} answered`);
    return this.pc.localDescription!.sdp;
  }

  /**
   * Initiate an outbound call — create SDP offer (Celina calls Albert).
   */
  async initiate(): Promise<string> {
    this.state = "answering";

    this.pc = new RTCPeerConnection({
      iceServers: this.iceServers.map((s) => ({
        urls: s.urls,
        username: s.username,
        credential: s.credential,
      })),
      headerExtensions: {
        audio: [useSdesMid(), useAbsSendTime()],
      },
    });

    const transceiver = this.pc.addTransceiver("audio", {
      direction: "sendrecv",
    });

    // Outbound offers are audio-only, so a remote answer cannot add video —
    // the kind guard here is defensive only.
    this.pc.onTrack.subscribe((mediaTrack: any) => {
      const track = mediaTrack.track ?? mediaTrack;
      const kind = track.kind ?? "audio";
      logger.info(TAG, `Remote track received: ${kind}`);
      if (kind === "video") {
        this.startVideoSampler(track);
        return;
      }
      this.startAudioBridge(
        track,
        (pkt: RtpPacket) => transceiver.sender.sendRtp(pkt)
      );
    });

    this.pc.onIceCandidate.subscribe((candidate) => {
      if (candidate && this.onLocalCandidate) {
        this.onLocalCandidate({
          candidate: candidate.candidate,
          sdpMLineIndex: candidate.sdpMLineIndex ?? 0,
          sdpMid: candidate.sdpMid ?? "0",
        });
      }
    });

    this.pc.iceConnectionStateChange.subscribe((state) => {
      logger.info(TAG, `ICE connection state: ${state}`);
      if (state === "disconnected" || state === "failed") {
        logger.warn(TAG, `ICE ${state}, hanging up`);
        this.hangup();
      }
    });

    // Create offer (not answer)
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);

    this.timeout = setTimeout(() => {
      logger.warn(TAG, `Outbound call ${this.callId} timed out`);
      this.hangup();
    }, this.callTimeoutMs);

    logger.info(TAG, `Outbound call ${this.callId} offer created`);
    return this.pc.localDescription!.sdp;
  }

  /**
   * Handle the remote answer to our outbound call offer.
   */
  async handleAnswer(answerSdp: string): Promise<void> {
    if (!this.pc) throw new Error("No peer connection");

    await this.pc.setRemoteDescription(
      new RTCSessionDescription(answerSdp, "answer")
    );

    for (const candidate of this.pendingCandidates) {
      await this.pc.addIceCandidate(candidate);
    }
    this.pendingCandidates = [];

    this.state = "active";
    logger.info(TAG, `Outbound call ${this.callId} connected`);
  }

  async addRemoteCandidate(candidate: {
    candidate: string;
    sdpMLineIndex: number;
    sdpMid: string;
  }): Promise<void> {
    const iceCandidate = new RTCIceCandidate({
      candidate: candidate.candidate,
      sdpMLineIndex: candidate.sdpMLineIndex,
      sdpMid: candidate.sdpMid,
    });

    if (!this.pc || !this.pc.remoteDescription) {
      this.pendingCandidates.push(iceCandidate);
      return;
    }

    await this.pc.addIceCandidate(iceCandidate);
  }

  private startAudioBridge(
    remoteTrack: any,
    sendRtp: (pkt: RtpPacket) => void
  ): void {
    this.audioBridge = new AudioBridge(this.sttSink, this.ttsSource);
    this.audioBridge.start(remoteTrack, sendRtp);
  }

  /**
   * Start the fail-soft video frame sampler for a remote video track.
   * Any failure here is logged and swallowed — the audio call continues.
   */
  private startVideoSampler(track: any): void {
    if (!this.videoConfig?.enabled) {
      logger.info(TAG, "Video track ignored (video disabled)");
      return;
    }
    if (this.videoSampler) {
      logger.warn(TAG, "Video sampler already running, ignoring extra video track");
      return;
    }
    try {
      const sampler = new VideoFrameSampler(this.videoConfig);
      sampler.attach(track, (): boolean => {
        const receiver =
          this.videoTransceiver?.receiver ??
          this.pc?.getTransceivers().find((t) => t.kind === "video")?.receiver;
        const ssrc: number | undefined = track.ssrc;
        if (receiver && typeof ssrc === "number") {
          receiver.sendRtcpPLI(ssrc).catch((err: any) => {
            logger.debug(TAG, `PLI send failed: ${err.message}`);
          });
          return true;
        }
        // ssrc not learned yet (offer without a=ssrc) — sampler retries on
        // the first received RTP packet, which teaches werift the ssrc.
        return false;
      });
      this.videoSampler = sampler;
    } catch (err: any) {
      logger.error(TAG, `Failed to start video sampler: ${err.message}`);
    }
  }

  /** Frame accessor for the voice pipeline / look tool. Safe when no video. */
  get videoFrameSource(): VideoFrameSource {
    return {
      isActive: () => this.videoSampler?.isActive() ?? false,
      getFrames: (count: number, spreadSeconds?: number) =>
        this.videoSampler?.getFrames(count, spreadSeconds) ?? [],
    };
  }

  hangup(): void {
    if (this.state === "hangup") return;
    this.state = "hangup";

    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }

    this.audioBridge?.stop();
    this.audioBridge = null;

    try {
      this.videoSampler?.stop();
    } catch {
      // fail soft — never let video cleanup break hangup
    }
    this.videoSampler = null;
    this.videoTransceiver = null;

    if (this.pc) {
      try {
        this.pc.close();
      } catch {
        // ignore
      }
      this.pc = null;
    }

    this.onHangup?.(this.callId);
    logger.info(TAG, `Call ${this.callId} hung up`);
  }
}
