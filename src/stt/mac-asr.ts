import { EventEmitter } from "events";
import childProcess from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { logger } from "../logger.js";

const TAG = "mac-asr";

/**
 * MacBook Voxtral Realtime ASR client.
 * Captures audio from PipeWire, detects speech via energy VAD,
 * sends segments to MacBook ASR API for transcription.
 *
 * Optimizations:
 * - Reduced VAD thresholds for faster speech boundary detection
 * - Reuse temp file path to avoid filesystem overhead
 * - Send audio as soon as speech ends (no extra buffering)
 *
 * Emits:
 * - "transcript" (text: string)
 * - "speech_started"
 */
export class MacASR extends EventEmitter {
  private recorder: childProcess.ChildProcess | null = null;
  private running = false;
  private transcribing = false;

  // VAD state
  private audioChunks: Buffer[] = [];
  private silenceFrames = 0;
  private speechDetected = false;

  // Tuned VAD thresholds
  private readonly SILENCE_THRESHOLD = 180;   // RMS — slightly lower for sensitivity
  private readonly SILENCE_FRAMES_END = 12;   // ~400ms of silence = end of speech
  private readonly MIN_SPEECH_BYTES = 6400;   // ~200ms minimum (was 8000)
  private readonly CAPTURE_RATE = 16000;

  // Reuse temp file to avoid filesystem overhead
  private readonly tmpPath = join(tmpdir(), "asr-live.wav");
  private readonly wavHeader: Buffer;

  constructor(
    private asrUrl: string,
    private asrApiKey: string,
    private captureSource: string,
    private asrModel: string = "Voxtral-Mini-4B-Realtime-2602-MLX-4bit"
  ) {
    super();
    // Pre-compute WAV header (updated per-write with correct data length)
    this.wavHeader = Buffer.alloc(44);
    this.wavHeader.write("RIFF", 0);
    this.wavHeader.write("WAVE", 8);
    this.wavHeader.write("fmt ", 12);
    this.wavHeader.writeUInt32LE(16, 16);
    this.wavHeader.writeUInt16LE(1, 20);      // PCM
    this.wavHeader.writeUInt16LE(1, 22);      // mono
    this.wavHeader.writeUInt32LE(this.CAPTURE_RATE, 24);
    this.wavHeader.writeUInt32LE(this.CAPTURE_RATE * 2, 28);
    this.wavHeader.writeUInt16LE(2, 32);      // block align
    this.wavHeader.writeUInt16LE(16, 34);     // bits per sample
    this.wavHeader.write("data", 36);
  }

  async start(): Promise<void> {
    this.running = true;
    this.startCapture();
    logger.info(TAG, `Voxtral ASR started (${this.asrUrl}, model=${this.asrModel})`);
  }

  private startCapture(): void {
    const { spawn } = childProcess;
    this.recorder = spawn("pw-record", [
      `--target=${this.captureSource}`,
      "--format=s16",
      `--rate=${this.CAPTURE_RATE}`,
      "--channels=1",
      "--latency=20ms",  // lower latency capture
      "-",
    ], { stdio: ["ignore", "pipe", "pipe"] });

    this.recorder.stdout?.on("data", (chunk: Buffer) => {
      if (this.running) {
        this.processAudioChunk(chunk);
      }
    });

    this.recorder.on("exit", (code: number) => {
      if (this.running) {
        logger.warn(TAG, `pw-record exited (${code}), restarting...`);
        setTimeout(() => this.startCapture(), 300);
      }
    });
  }

  private processAudioChunk(chunk: Buffer): void {
    const rms = this.computeRMS(chunk);

    if (rms > this.SILENCE_THRESHOLD) {
      if (!this.speechDetected) {
        this.speechDetected = true;
        this.audioChunks = [];
        this.emit("speech_started");
      }
      this.silenceFrames = 0;
      this.audioChunks.push(chunk);
    } else if (this.speechDetected) {
      this.silenceFrames++;
      this.audioChunks.push(chunk);

      if (this.silenceFrames >= this.SILENCE_FRAMES_END) {
        const pcm = Buffer.concat(this.audioChunks);
        this.speechDetected = false;
        this.silenceFrames = 0;
        this.audioChunks = [];

        if (pcm.length >= this.MIN_SPEECH_BYTES && !this.transcribing) {
          this.transcribe(pcm);
        }
      }
    }
  }

  private computeRMS(chunk: Buffer): number {
    let sum = 0;
    const samples = chunk.length / 2;
    for (let i = 0; i < chunk.length - 1; i += 2) {
      const sample = chunk.readInt16LE(i);
      sum += sample * sample;
    }
    return Math.sqrt(sum / samples);
  }

  private async transcribe(pcm: Buffer): Promise<void> {
    this.transcribing = true;
    try {
      const duration = pcm.length / (this.CAPTURE_RATE * 2);

      // Write WAV directly — reuse header, update data length
      const header = Buffer.from(this.wavHeader);
      header.writeUInt32LE(pcm.length + 36, 4);  // RIFF size
      header.writeUInt32LE(pcm.length, 40);       // data size
      writeFileSync(this.tmpPath, Buffer.concat([header, pcm]));

      logger.debug(TAG, `Transcribing ${duration.toFixed(1)}s...`);
      const t0 = Date.now();

      // Send to Voxtral ASR
      const { readFileSync } = await import("fs");
      const fileData = readFileSync(this.tmpPath);
      const formData = new FormData();
      formData.append("file", new Blob([fileData], { type: "audio/wav" }), "audio.wav");
      formData.append("model", this.asrModel);

      const resp = await fetch(`${this.asrUrl}/audio/transcriptions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.asrApiKey}`,
        },
        body: formData,
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "unknown");
        logger.error(TAG, `ASR error ${resp.status}: ${errText}`);
        return;
      }

      const result: any = await resp.json();
      const text = result.text?.trim();
      const elapsed = Date.now() - t0;

      if (text && text.length > 0) {
        logger.info(TAG, `Transcribed in ${elapsed}ms: "${text}"`);
        this.emit("transcript", text);
      }
    } catch (err: any) {
      logger.error(TAG, `Transcription failed: ${err.message}`);
    } finally {
      this.transcribing = false;
    }
  }

  stop(): void {
    this.running = false;
    if (this.recorder) {
      try { this.recorder.kill("SIGTERM"); } catch {}
      this.recorder = null;
    }
    // Clean up temp file
    try { unlinkSync(this.tmpPath); } catch {}
    logger.info(TAG, "Voxtral ASR stopped");
  }
}
