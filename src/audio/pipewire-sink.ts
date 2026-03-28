import { ChildProcess, spawn } from "child_process";
import { logger } from "../logger.js";

const TAG = "pw-sink";

/**
 * Writes raw PCM audio to a PipeWire sink via pw-play subprocess.
 * Used for incoming call audio → STT pipeline.
 */
export class PipeWireSink {
  private proc: ChildProcess | null = null;
  private target: string;
  private running = false;

  constructor(target: string) {
    this.target = target;
  }

  start(): void {
    if (this.running) return;

    this.proc = spawn("pw-play", [
      `--target=${this.target}`,
      "--format=s16le",
      "--rate=48000",
      "--channels=1",
      "--latency=50ms",
      "-",
    ], {
      stdio: ["pipe", "ignore", "pipe"],
    });

    this.running = true;

    this.proc.stderr?.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) logger.warn(TAG, `pw-play stderr: ${msg}`);
    });

    this.proc.on("exit", (code) => {
      logger.info(TAG, `pw-play exited with code ${code}`);
      this.running = false;
      this.proc = null;
    });

    this.proc.on("error", (err) => {
      logger.error(TAG, "pw-play spawn error", err.message);
      this.running = false;
      this.proc = null;
    });

    logger.info(TAG, `Started pw-play → ${this.target}`);
  }

  write(pcm: Buffer): boolean {
    if (!this.running || !this.proc?.stdin?.writable) return false;
    return this.proc.stdin.write(pcm);
  }

  stop(): void {
    if (!this.running || !this.proc) return;
    this.running = false;

    try {
      this.proc.stdin?.end();
      this.proc.kill("SIGTERM");
    } catch {
      // ignore
    }

    this.proc = null;
    logger.info(TAG, "Stopped pw-play");
  }

  get isRunning(): boolean {
    return this.running;
  }
}
