import { ChildProcess, spawn } from "child_process";
import { EventEmitter } from "events";
import { FRAME_BYTES } from "./opus-codec.js";
import { logger } from "../logger.js";

const TAG = "pw-source";

/**
 * Captures raw PCM audio from a PipeWire source via pw-record subprocess.
 * Used for TTS output → outgoing call audio.
 * Emits 'frame' events with 20ms PCM buffers.
 */
export class PipeWireSource extends EventEmitter {
  private proc: ChildProcess | null = null;
  private target: string;
  private running = false;
  private remainder: Buffer = Buffer.alloc(0);

  constructor(target: string) {
    super();
    this.target = target;
  }

  start(): void {
    if (this.running) return;

    this.proc = spawn("pw-record", [
      `--target=${this.target}`,
      "--format=s16le",
      "--rate=48000",
      "--channels=1",
      "--latency=50ms",
      "-",
    ], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.running = true;

    this.proc.stdout?.on("data", (chunk: Buffer) => {
      this.processChunk(chunk);
    });

    this.proc.stderr?.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) logger.warn(TAG, `pw-record stderr: ${msg}`);
    });

    this.proc.on("exit", (code) => {
      logger.info(TAG, `pw-record exited with code ${code}`);
      this.running = false;
      this.proc = null;
    });

    this.proc.on("error", (err) => {
      logger.error(TAG, "pw-record spawn error", err.message);
      this.running = false;
      this.proc = null;
    });

    logger.info(TAG, `Started pw-record ← ${this.target}`);
  }

  private processChunk(chunk: Buffer): void {
    // Concatenate with any leftover from previous chunk
    let buf = this.remainder.length > 0
      ? Buffer.concat([this.remainder, chunk])
      : chunk;

    // Emit complete 20ms frames
    while (buf.length >= FRAME_BYTES) {
      const frame = buf.subarray(0, FRAME_BYTES);
      this.emit("frame", Buffer.from(frame));
      buf = buf.subarray(FRAME_BYTES);
    }

    // Save any remainder
    this.remainder = buf.length > 0 ? Buffer.from(buf) : Buffer.alloc(0);
  }

  stop(): void {
    if (!this.running || !this.proc) return;
    this.running = false;

    try {
      this.proc.kill("SIGTERM");
    } catch {
      // ignore
    }

    this.proc = null;
    this.remainder = Buffer.alloc(0);
    logger.info(TAG, "Stopped pw-record");
  }

  get isRunning(): boolean {
    return this.running;
  }
}
