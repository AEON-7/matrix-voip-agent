import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { logger } from "../logger.js";

const TAG = "whisper-local";

/**
 * Local whisper.cpp STT via whisper-server HTTP API.
 *
 * Captures audio from a PipeWire source, buffers it with VAD,
 * and sends chunks to the local whisper-server for transcription.
 *
 * The whisper-server must be running separately (or managed by a systemd service).
 */
export class WhisperLocalSTT extends EventEmitter {
  private pwRecord: ChildProcess | null = null;
  private audioBuffer: Buffer[] = [];
  private bufferBytes = 0;
  private running = false;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private silenceStart = 0;
  private hasSpeech = false;
  private serverProcess: ChildProcess | null = null;

  // Audio params: 16kHz, 16-bit signed LE, mono
  private readonly sampleRate = 16000;
  private readonly bytesPerSample = 2;
  private readonly bytesPerSecond = this.sampleRate * this.bytesPerSample;

  // Silence detection: RMS threshold on PCM samples
  private readonly silenceThresholdRms = 150;
  private readonly silenceDurationMs = 800;
  private readonly minSpeechMs = 500;
  private readonly maxBufferSeconds = 30;

  constructor(
    private serverUrl: string,
    private pipewireSource: string,
    private whisperBin: string,
    private modelPath: string,
    private vadModelPath: string,
    private language: string = "auto",
    private autoStartServer: boolean = true,
    private serverPort: number = 8178
  ) {
    super();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Optionally start whisper-server
    if (this.autoStartServer) {
      await this.startServer();
    }

    // Wait for server to be ready
    await this.waitForServer(10000);

    // Start capturing from PipeWire
    this.startCapture();

    // Periodic flush check (backup for silence detection)
    this.flushTimer = setInterval(() => this.checkFlush(), 500);

    logger.info(TAG, "Whisper local STT started");
  }

  private async startServer(): Promise<void> {
    const args = [
      "-m", this.modelPath,
      "--language", this.language,
      "--host", "127.0.0.1",
      "--port", String(this.serverPort),
      "--convert",
      "--tmp-dir", "/tmp",
      "-t", "4",
      "-sns",
    ];

    // Note: VAD is handled by our own silence detection in processAudio(),
    // so we don't need whisper-server's built-in VAD.

    logger.info(TAG, `Starting whisper-server: ${this.whisperBin} ${args.join(" ")}`);

    this.serverProcess = spawn(this.whisperBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: "/tmp",
    });

    this.serverProcess.stdout?.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) logger.info(TAG, `server stdout: ${msg}`);
    });

    this.serverProcess.stderr?.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) logger.info(TAG, `server stderr: ${msg}`);
    });

    this.serverProcess.on("exit", (code) => {
      logger.warn(TAG, `whisper-server exited with code ${code}`);
      if (this.running) {
        // Auto-restart
        setTimeout(() => this.startServer(), 2000);
      }
    });
  }

  private async waitForServer(timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const resp = await fetch(`${this.serverUrl}/`);
        if (resp.ok || resp.status === 200) {
          // Server is listening — give the model a moment to fully load
          logger.info(TAG, "whisper-server HTTP endpoint is up, waiting for model load...");
          await new Promise((r) => setTimeout(r, 3000));
          logger.info(TAG, "whisper-server is ready");
          return;
        }
      } catch {
        // Not ready yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("whisper-server did not become ready in time");
  }

  private startCapture(): void {
    this.pwRecord = spawn("pw-record", [
      `--target=${this.pipewireSource}`,
      "--format=s16",
      `--rate=${this.sampleRate}`,
      "--channels=1",
      "--latency=20ms",
      "-",
    ], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.pwRecord.stdout?.on("data", (chunk: Buffer) => {
      if (!this.running) return;
      this.processAudio(chunk);
    });

    this.pwRecord.stderr?.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg && !msg.includes("Stream")) logger.debug(TAG, `pw-record: ${msg}`);
    });

    this.pwRecord.on("exit", (code) => {
      logger.info(TAG, `pw-record exited with code ${code}`);
      if (this.running) {
        setTimeout(() => this.startCapture(), 1000);
      }
    });

    logger.info(TAG, `Capturing from ${this.pipewireSource} at ${this.sampleRate}Hz`);
  }

  private rmsLogCounter = 0;

  private processAudio(chunk: Buffer): void {
    const rms = this.computeRms(chunk);
    const isSpeech = rms > this.silenceThresholdRms;

    // Log RMS every ~2 seconds (100 chunks at 20ms each)
    this.rmsLogCounter++;
    if (this.rmsLogCounter % 100 === 0) {
      logger.info(TAG, `Audio RMS: ${rms.toFixed(0)} (threshold: ${this.silenceThresholdRms}, speech: ${isSpeech}, buffering: ${this.hasSpeech})`);
    }

    if (isSpeech) {
      if (!this.hasSpeech) {
        this.hasSpeech = true;
        this.emit("speech_started");
        logger.info(TAG, `Speech detected (RMS: ${rms.toFixed(0)})`);
      }
      this.silenceStart = 0;
      this.audioBuffer.push(chunk);
      this.bufferBytes += chunk.length;
    } else if (this.hasSpeech) {
      // Still collecting during silence gap
      this.audioBuffer.push(chunk);
      this.bufferBytes += chunk.length;

      if (!this.silenceStart) {
        this.silenceStart = Date.now();
      } else if (Date.now() - this.silenceStart >= this.silenceDurationMs) {
        // End of speech — flush for transcription
        this.emit("speech_stopped");
        this.flushBuffer();
      }
    }

    // Safety: don't buffer forever
    if (this.bufferBytes > this.maxBufferSeconds * this.bytesPerSecond) {
      this.flushBuffer();
    }
  }

  private computeRms(chunk: Buffer): number {
    let sumSq = 0;
    const samples = chunk.length / this.bytesPerSample;
    for (let i = 0; i < chunk.length - 1; i += 2) {
      const sample = chunk.readInt16LE(i);
      sumSq += sample * sample;
    }
    return Math.sqrt(sumSq / samples);
  }

  private checkFlush(): void {
    // Backup: if we have buffered speech and silence timer has passed
    if (this.hasSpeech && this.silenceStart &&
        Date.now() - this.silenceStart >= this.silenceDurationMs) {
      this.flushBuffer();
    }
  }

  private async flushBuffer(): Promise<void> {
    if (this.audioBuffer.length === 0) {
      this.hasSpeech = false;
      this.silenceStart = 0;
      return;
    }

    const pcm = Buffer.concat(this.audioBuffer);
    this.audioBuffer = [];
    this.bufferBytes = 0;
    this.hasSpeech = false;
    this.silenceStart = 0;

    const durationMs = (pcm.length / this.bytesPerSecond) * 1000;
    if (durationMs < this.minSpeechMs) {
      logger.debug(TAG, `Skipping short audio: ${durationMs.toFixed(0)}ms`);
      return;
    }

    logger.info(TAG, `Flushing ${durationMs.toFixed(0)}ms of audio (${pcm.length} bytes) to whisper-server`);

    try {
      const transcript = await this.transcribe(pcm);
      logger.info(TAG, `Whisper returned: "${transcript}"`);
      if (transcript && transcript.trim()) {
        this.emit("transcript", transcript.trim());
      }
    } catch (err: any) {
      logger.error(TAG, `Transcription error: ${err.message}`);
    }
  }

  private async transcribe(pcm: Buffer): Promise<string> {
    const { writeFileSync, unlinkSync } = await import("fs");
    const { join } = await import("path");
    const { tmpdir } = await import("os");
    const { execSync } = await import("child_process");

    // Write WAV to temp file (whisper-server works reliably with file uploads via curl)
    const wav = this.pcmToWav(pcm);
    const tmpPath = join(tmpdir(), `whisper-stt-${Date.now()}.wav`);

    try {
      writeFileSync(tmpPath, wav);

      // Debug: save first WAV for inspection
      const debugPath = join(tmpdir(), "whisper-debug-latest.wav");
      try { writeFileSync(debugPath, wav); } catch {}

      const result = execSync(
        `curl -s -X POST ${this.serverUrl}/inference -F "file=@${tmpPath}" -F "response_format=json" 2>&1`,
        { timeout: 30000 }
      ).toString();

      logger.info(TAG, `Curl raw response (${result.length} chars): ${result.slice(0, 300)}`);

      if (!result.trim()) return "";
      const json = JSON.parse(result);
      return json.text || "";
    } catch (err: any) {
      logger.error(TAG, `Transcribe error: ${err.message}`);
      return "";
    } finally {
      try { unlinkSync(tmpPath); } catch {}
    }
  }

  private pcmToWav(pcm: Buffer): Buffer {
    const header = Buffer.alloc(44);
    const dataSize = pcm.length;
    const fileSize = 36 + dataSize;

    header.write("RIFF", 0);
    header.writeUInt32LE(fileSize, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);           // fmt chunk size
    header.writeUInt16LE(1, 20);            // PCM format
    header.writeUInt16LE(1, 22);            // mono
    header.writeUInt32LE(this.sampleRate, 24);
    header.writeUInt32LE(this.bytesPerSecond, 28);
    header.writeUInt16LE(this.bytesPerSample, 32);
    header.writeUInt16LE(16, 34);           // bits per sample
    header.write("data", 36);
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, pcm]);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.pwRecord) {
      try { this.pwRecord.kill("SIGTERM"); } catch {}
      this.pwRecord = null;
    }

    if (this.serverProcess) {
      try { this.serverProcess.kill("SIGTERM"); } catch {}
      this.serverProcess = null;
    }

    logger.info(TAG, "Whisper local STT stopped");
  }

  get isRunning(): boolean {
    return this.running;
  }
}
