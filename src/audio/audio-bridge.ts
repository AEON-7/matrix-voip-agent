import { MediaStreamTrack, RtpPacket, RtpHeader } from "werift";
import { PipeWireSink } from "./pipewire-sink.js";
import { PipeWireSource } from "./pipewire-source.js";
import {
  createCodec,
  encodePcmToOpus,
  decodeOpusToPcm,
  silentFrame,
  FRAME_SAMPLES,
} from "./opus-codec.js";
import { logger } from "../logger.js";

const TAG = "audio-bridge";
const FRAME_INTERVAL_MS = 20;

/**
 * Bidirectional audio bridge between a WebRTC call and PipeWire virtual devices.
 *
 * Incoming: remote audio track → Opus decode → PCM → pw-play → STT sink
 * Outgoing: pw-record → TTS source → PCM → Opus encode → sender.sendRtp
 */
export class AudioBridge {
  private sink: PipeWireSink;
  private source: PipeWireSource;
  private encCodec = createCodec();
  private decCodec = createCodec();
  private running = false;
  private silenceTimer: ReturnType<typeof setInterval> | null = null;
  private lastSourceFrame = 0;
  private rtpSeq = 0;
  private rtpTimestamp = 0;
  private payloadType = 111; // Opus default, may be overridden

  constructor(
    sttSinkTarget: string,
    ttsMicTarget: string
  ) {
    this.sink = new PipeWireSink(sttSinkTarget);
    this.source = new PipeWireSource(ttsMicTarget);
  }

  /**
   * Start the audio bridge.
   * @param remoteTrack - The receiver's track (incoming audio from caller)
   * @param sendRtp - Function to send RTP packets out (from transceiver.sender.sendRtp)
   * @param payloadType - Opus payload type from SDP negotiation
   * @param ssrc - Local SSRC for outgoing RTP
   */
  start(
    remoteTrack: MediaStreamTrack,
    sendRtp: (packet: RtpPacket) => void,
    payloadType: number = 111,
    ssrc: number = Math.floor(Math.random() * 0xffffffff)
  ): void {
    if (this.running) return;
    this.running = true;
    this.payloadType = payloadType;

    this.sink.start();
    this.source.start();

    // Incoming audio: remote RTP → Opus decode → PipeWire STT sink
    remoteTrack.onReceiveRtp.subscribe((rtp: RtpPacket) => {
      if (!this.running) return;
      try {
        const pcm = decodeOpusToPcm(this.decCodec, rtp.payload);
        this.sink.write(pcm);
      } catch {
        logger.debug(TAG, "Opus decode error (may be DTX/silence)");
      }
    });

    // Outgoing audio: PipeWire TTS source → Opus encode → RTP
    this.source.on("frame", (pcm: Buffer) => {
      if (!this.running) return;
      this.lastSourceFrame = Date.now();
      try {
        const opus = encodePcmToOpus(this.encCodec, pcm);
        this.emitRtp(sendRtp, opus, ssrc);
      } catch {
        logger.debug(TAG, "Opus encode error");
      }
    });

    // Silence keepalive
    this.silenceTimer = setInterval(() => {
      if (!this.running) return;
      const elapsed = Date.now() - this.lastSourceFrame;
      if (elapsed > 100) {
        try {
          const opus = encodePcmToOpus(this.encCodec, silentFrame());
          this.emitRtp(sendRtp, opus, ssrc);
        } catch {
          // ignore
        }
      }
    }, FRAME_INTERVAL_MS);

    logger.info(TAG, "Audio bridge started");
  }

  private emitRtp(
    sendRtp: (packet: RtpPacket) => void,
    opusPayload: Buffer,
    ssrc: number
  ): void {
    this.rtpSeq = (this.rtpSeq + 1) & 0xffff;
    this.rtpTimestamp += FRAME_SAMPLES;

    const header = new RtpHeader();
    header.payloadType = this.payloadType;
    header.sequenceNumber = this.rtpSeq;
    header.timestamp = this.rtpTimestamp & 0xffffffff;
    header.ssrc = ssrc;
    header.marker = false;

    const packet = new RtpPacket(header, opusPayload);

    try {
      sendRtp(packet);
    } catch {
      logger.debug(TAG, "sendRtp error");
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.silenceTimer) {
      clearInterval(this.silenceTimer);
      this.silenceTimer = null;
    }

    this.sink.stop();
    this.source.stop();

    logger.info(TAG, "Audio bridge stopped");
  }

  get isRunning(): boolean {
    return this.running;
  }
}
