import {
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
  RtpPacket,
  useAbsSendTime,
  useSdesMid,
} from "werift";
import { AudioBridge } from "../audio/audio-bridge.js";
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
    private callTimeoutMs: number
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

    // Handle remote track (incoming audio from caller)
    // werift's onTrack emits MediaStreamTrack directly
    this.pc.onTrack.subscribe((mediaTrack: any) => {
      const track = mediaTrack.track ?? mediaTrack;
      logger.info(TAG, `Remote track received: ${track.kind ?? "audio"}`);
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

    this.pc.onTrack.subscribe((mediaTrack: any) => {
      const track = mediaTrack.track ?? mediaTrack;
      logger.info(TAG, `Remote track received: ${track.kind ?? "audio"}`);
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

  hangup(): void {
    if (this.state === "hangup") return;
    this.state = "hangup";

    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }

    this.audioBridge?.stop();
    this.audioBridge = null;

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
