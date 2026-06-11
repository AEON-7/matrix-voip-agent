import childProcess from "child_process";
import type { MediaStreamTrack, RtpPacket } from "werift";
import {
  JitterBufferCallback,
  RtpTimeCallback,
  DepacketizeCallback,
} from "werift/nonstandard";
import { logger } from "../logger.js";

const TAG = "frame-sampler";

const VIDEO_CLOCK_RATE = 90000; // RTP clock rate for all video codecs
const STALL_TIMEOUT_MS = 5000;
const PLI_MIN_INTERVAL_MS = 1000;
const IVF_HEADER_SIZE = 32;
const IVF_FRAME_HEADER_SIZE = 12;

const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

export interface VideoFrame {
  /** Wall-clock time (ms since epoch) the JPEG came out of the decoder */
  ts: number;
  jpeg: Buffer;
}

/**
 * Video sampler knobs (per-agent .env, all optional / safe to omit):
 *   VIDEO_ENABLED=false    — master switch for video sampling (opt-in per agent)
 *   VIDEO_FRAME_FPS=1      — frames/sec kept by ffmpeg's fps filter (0.5 halves)
 *   VIDEO_FRAME_WIDTH=512  — output JPEG width, height keeps aspect ratio
 *   VIDEO_RING_SIZE=8      — frames retained in the ring buffer
 *   VIDEO_AUTO_ATTACH=off  — off|latest (consumed by the voice pipeline)
 */
export interface VideoSamplerConfig {
  enabled: boolean;
  frameFps: number;
  frameWidth: number;
  ringSize: number;
}

/** Read-only frame accessor handed to the voice pipeline / look tool. */
export interface VideoFrameSource {
  isActive(): boolean;
  getFrames(count: number, spreadSeconds?: number): VideoFrame[];
}

/**
 * ffmpeg filter/output args shared by the live sampler and the smoke test.
 * Frame dropping happens HERE — frames beyond frameFps never become JPEGs.
 * scale=W:-2 keeps aspect but forces an even height (mjpeg over yuv420p
 * rejects odd dimensions, which scale=W:-1 can produce).
 */
export function ffmpegSampleArgs(fps: number, width: number): string[] {
  return [
    "-vf", `fps=${fps},scale=${width}:-2`,
    "-f", "image2pipe",
    "-c:v", "mjpeg",
    "-q:v", "4",
    "pipe:1",
  ];
}

/**
 * IVF file header for a VP8 elementary stream. Timebase is 1/1000 so frame
 * pts values are plain milliseconds. Width/height are placeholders — ffmpeg's
 * VP8 decoder takes the real dimensions from the keyframe bitstream.
 */
export function ivfFileHeader(width = 640, height = 480): Buffer {
  const h = Buffer.alloc(IVF_HEADER_SIZE);
  h.write("DKIF", 0, "ascii");
  h.writeUInt16LE(0, 4); // version
  h.writeUInt16LE(IVF_HEADER_SIZE, 6); // header length
  h.write("VP80", 8, "ascii"); // codec FourCC
  h.writeUInt16LE(width, 12);
  h.writeUInt16LE(height, 14);
  h.writeUInt32LE(1000, 16); // timebase denominator
  h.writeUInt32LE(1, 20); // timebase numerator
  h.writeUInt32LE(0, 24); // frame count (unknown, streaming)
  return h;
}

/** 12-byte IVF frame header: frame size + pts (ms, per the header timebase). */
export function ivfFrameHeader(frameSize: number, ptsMs: number): Buffer {
  const h = Buffer.alloc(IVF_FRAME_HEADER_SIZE);
  h.writeUInt32LE(frameSize, 0);
  h.writeBigUInt64LE(BigInt(Math.max(0, Math.round(ptsMs))), 4);
  return h;
}

/**
 * Splits a concatenated MJPEG byte stream (ffmpeg image2pipe output) into
 * individual JPEGs via SOI (FFD8) / EOI (FFD9) framing. This is safe because
 * JPEG entropy-coded data byte-stuffs 0xFF as FF00 and restart markers are
 * FFD0-FFD7, so a literal FFD9 only occurs at end-of-image.
 */
export class JpegStreamParser {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer, onJpeg: (jpeg: Buffer) => void): void {
    this.buffer = this.buffer.length
      ? Buffer.concat([this.buffer, chunk])
      : chunk;

    for (;;) {
      const soi = this.buffer.indexOf(JPEG_SOI);
      if (soi < 0) {
        // Keep a trailing 0xFF — it may be the first byte of an SOI split
        // across chunks; dropping it would lose the next frame until resync.
        this.buffer =
          this.buffer.length > 0 && this.buffer[this.buffer.length - 1] === 0xff
            ? Buffer.from([0xff])
            : Buffer.alloc(0);
        return;
      }
      const eoi = this.buffer.indexOf(JPEG_EOI, soi + 2);
      if (eoi < 0) {
        // Incomplete image — keep from SOI and wait for more data
        if (soi > 0) this.buffer = this.buffer.subarray(soi);
        return;
      }
      onJpeg(this.buffer.subarray(soi, eoi + 2));
      this.buffer = this.buffer.subarray(eoi + 2);
    }
  }
}

/**
 * Per-call video frame sampler:
 *
 * VP8 RTP → jitter buffer → RTP-ts→ms → depacketize (whole VP8 frames)
 *   → IVF mux → persistent ffmpeg child (fps drop + scale + mjpeg)
 *   → JPEG ring buffer, pulled on demand by the look tool.
 *
 * Every failure path disables the sampler and logs — it must NEVER throw
 * into the call path. Voice keeps working with no camera.
 */
export class VideoFrameSampler implements VideoFrameSource {
  private running = false;
  private disabled = false;
  private ffmpeg: childProcess.ChildProcess | null = null;
  private jitter: JitterBufferCallback | null = null;
  private rtpTime: RtpTimeCallback | null = null;
  private depacketizer: DepacketizeCallback | null = null;
  private jpegParser = new JpegStreamParser();
  private ring: VideoFrame[] = [];
  private ivfHeaderWritten = false;
  private startedAt = 0;
  private lastFrameAt = 0;
  private lastPliAt = 0;
  private framesFed = 0;
  private framesDecoded = 0;
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  private rtpUnsubscribe: (() => void) | null = null;
  /** Returns false when the PLI could not be sent (e.g. ssrc not yet known). */
  private requestKeyframe: () => boolean | void = () => {};

  constructor(private config: VideoSamplerConfig) {}

  attach(track: MediaStreamTrack, requestKeyframe: () => boolean | void): void {
    if (this.running || this.disabled) return;
    this.requestKeyframe = requestKeyframe;

    try {
      this.spawnFfmpeg();
    } catch (err: any) {
      logger.error(TAG, `ffmpeg spawn failed, video sampling disabled: ${err.message}`);
      this.disable();
      return;
    }

    this.running = true;
    this.startedAt = Date.now();

    // VP8 framing: the RTP marker bit terminates a frame; waitForKeyframe
    // drops partial pre-keyframe data and fires onNeedKeyFrame until a
    // keyframe arrives. RtpTime converts the 90kHz RTP clock to ms for pts.
    const jitter = new JitterBufferCallback(VIDEO_CLOCK_RATE);
    const rtpTime = new RtpTimeCallback(VIDEO_CLOCK_RATE);
    const depacketizer = new DepacketizeCallback("vp8", {
      waitForKeyframe: true,
      isFinalPacketInSequence: (h) => h.marker,
    });
    jitter.pipe((o) => rtpTime.input(o));
    rtpTime.pipe((o) => depacketizer.input(o));
    depacketizer.pipe((o) => {
      if (o.frame) this.writeVp8Frame(o.frame.data, o.frame.time);
    });
    depacketizer.onNeedKeyFrame.subscribe(() => this.safeRequestKeyframe("pre-keyframe"));
    this.jitter = jitter;
    this.rtpTime = rtpTime;
    this.depacketizer = depacketizer;

    let firstRtpSeen = false;
    const { unSubscribe } = track.onReceiveRtp.subscribe((rtp: RtpPacket) => {
      if (!this.running) return;
      if (!firstRtpSeen) {
        firstRtpSeen = true;
        // werift has now learned the track ssrc from the packet itself —
        // retry the start PLI in case it no-op'd (offer without a=ssrc).
        if (this.framesFed === 0) this.safeRequestKeyframe("first-rtp");
      }
      try {
        jitter.input({ rtp });
      } catch (err: any) {
        logger.debug(TAG, `RTP input error: ${err.message}`);
      }
    });
    this.rtpUnsubscribe = unSubscribe;

    // The sender won't produce a keyframe until asked — PLI immediately so
    // the depacketizer can sync, then watch for decode stalls.
    this.safeRequestKeyframe("start");
    this.stallTimer = setInterval(() => this.checkStall(), STALL_TIMEOUT_MS);

    logger.info(
      TAG,
      `Video sampler started (fps=${this.config.frameFps}, width=${this.config.frameWidth}, ring=${this.config.ringSize})`
    );
  }

  isActive(): boolean {
    return this.running && !this.disabled;
  }

  /**
   * Pull the freshest frame(s) from the ring buffer.
   * With spreadSeconds > 0 frames are picked evenly across that window
   * (always including the freshest one) for motion context.
   */
  getFrames(count: number, spreadSeconds = 0): VideoFrame[] {
    const n = Math.max(1, Math.min(4, Math.floor(count) || 1));
    if (this.ring.length === 0) return [];

    if (spreadSeconds > 0 && this.ring.length > 1 && n > 1) {
      const cutoff = Date.now() - spreadSeconds * 1000;
      const window = this.ring.filter((f) => f.ts >= cutoff);
      const pool = window.length >= 2 ? window : this.ring;
      if (pool.length <= n) return [...pool];
      const picked = new Set<VideoFrame>();
      for (let i = 0; i < n; i++) {
        picked.add(pool[Math.round((i * (pool.length - 1)) / (n - 1))]);
      }
      return [...picked];
    }

    return this.ring.slice(-n);
  }

  stop(): void {
    this.teardown();
  }

  private disable(): void {
    this.disabled = true;
    this.teardown();
  }

  private spawnFfmpeg(): void {
    const args = [
      "-hide_banner", "-loglevel", "error",
      "-f", "ivf", "-i", "pipe:0",
      ...ffmpegSampleArgs(this.config.frameFps, this.config.frameWidth),
    ];
    const proc = childProcess.spawn("ffmpeg", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.ffmpeg = proc;

    proc.stdout?.on("data", (chunk: Buffer) => {
      this.jpegParser.push(chunk, (jpeg) => this.pushFrame(jpeg));
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) logger.warn(TAG, `ffmpeg: ${msg}`);
    });

    proc.stdin?.on("error", () => {}); // EPIPE if ffmpeg dies; exit handler cleans up

    proc.on("error", (err) => {
      logger.error(TAG, `ffmpeg process error, video sampling disabled: ${err.message}`);
      this.disable();
    });

    proc.on("exit", (code, signal) => {
      if (this.ffmpeg !== proc) return; // already torn down
      if (this.running) {
        logger.warn(TAG, `ffmpeg exited unexpectedly (code=${code}, signal=${signal}), video sampling disabled`);
        this.disable();
      }
    });
  }

  private writeVp8Frame(data: Buffer, timeMs: number): void {
    const stdin = this.ffmpeg?.stdin;
    if (!this.running || !stdin || stdin.destroyed || data.length === 0) return;
    try {
      if (!this.ivfHeaderWritten) {
        stdin.write(ivfFileHeader());
        this.ivfHeaderWritten = true;
      }
      stdin.write(ivfFrameHeader(data.length, timeMs));
      stdin.write(data);
      this.framesFed++;
    } catch (err: any) {
      logger.debug(TAG, `ffmpeg stdin write error: ${err.message}`);
    }
  }

  private pushFrame(jpeg: Buffer): void {
    if (!this.running) return; // ignore final ffmpeg flush after stop()
    this.lastFrameAt = Date.now();
    this.framesDecoded++;
    this.ring.push({ ts: this.lastFrameAt, jpeg: Buffer.from(jpeg) });
    if (this.ring.length > Math.max(1, this.config.ringSize)) {
      this.ring.shift();
    }
    if (this.framesDecoded === 1) {
      logger.info(TAG, `First video frame decoded (${jpeg.length} bytes)`);
    }
  }

  private checkStall(): void {
    if (!this.running) return;
    const last = this.lastFrameAt || this.startedAt;
    if (Date.now() - last >= STALL_TIMEOUT_MS) {
      // Decoder is starved — almost always a missing keyframe (loss, or the
      // sender never sent one). PLI is the standard recovery lever.
      this.safeRequestKeyframe("stall");
    }
  }

  private safeRequestKeyframe(reason: string): void {
    const now = Date.now();
    if (now - this.lastPliAt < PLI_MIN_INTERVAL_MS) return;
    try {
      const sent = this.requestKeyframe();
      if (sent === false) {
        // PLI could not go out (ssrc not yet learned) — leave the rate
        // limiter unarmed so the first-rtp/stall retry fires immediately.
        logger.debug(TAG, `PLI skipped (reason=${reason}): ssrc not yet known`);
        return;
      }
      this.lastPliAt = now;
      logger.debug(TAG, `Requesting keyframe (PLI, reason=${reason})`);
    } catch (err: any) {
      this.lastPliAt = now;
      logger.debug(TAG, `PLI request failed: ${err.message}`);
    }
  }

  private teardown(): void {
    if (!this.running && !this.ffmpeg) return;
    this.running = false;

    if (this.stallTimer) {
      clearInterval(this.stallTimer);
      this.stallTimer = null;
    }

    try { this.rtpUnsubscribe?.(); } catch {}
    this.rtpUnsubscribe = null;

    try { this.jitter?.destroy(); } catch {}
    try { this.rtpTime?.destroy(); } catch {}
    try { this.depacketizer?.destroy(); } catch {}
    this.jitter = null;
    this.rtpTime = null;
    this.depacketizer = null;

    const proc = this.ffmpeg;
    this.ffmpeg = null;
    if (proc) {
      try { proc.stdin?.end(); } catch {}
      try { proc.kill("SIGTERM"); } catch {}
      // Guarantee no zombie ffmpeg child outlives the call
      setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch {}
      }, 2000).unref?.();
    }

    logger.info(TAG, `Video sampler stopped (fed=${this.framesFed} VP8 frames, decoded=${this.framesDecoded} JPEGs)`);
  }
}
