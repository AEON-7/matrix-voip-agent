import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { logger } from "../logger.js";

const TAG = "qwen-asr-http";

/**
 * Qwen3-ASR via the OpenAI-compatible HTTP endpoint exposed by
 * `aeon-7/qwen3-asr-server` (vLLM-native serving Qwen/Qwen3-ASR-0.6B by
 * default). Drop-in replacement for `WhisperLocalSTT` that points at a
 * remote / LAN endpoint instead of spawning whisper.cpp locally.
 *
 * Same shape as `WhisperLocalSTT`: captures PCM from a PipeWire source,
 * does local RMS-based VAD, POSTs WAV chunks to
 * `${endpoint}/v1/audio/transcriptions`, and emits 'transcript' / 'speech_started'
 * / 'speech_stopped' events.
 *
 * The endpoint URL should be the full /v1 base URL, e.g.
 *   http://192.168.1.116:8001/v1
 *
 * RTF on DGX Spark hot path: ~16x real-time (120 ms transcription for a
 * 2 s clip). Sub-LAN hop adds ~1-2 ms. End-to-end ASR latency from
 * speech-stop to transcript ~150 ms at conversational utterance lengths.
 */
export class QwenAsrHttpSTT extends EventEmitter {
  private pwRecord: ChildProcess | null = null;
  private audioBuffer: Buffer[] = [];
  private bufferBytes = 0;
  private running = false;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private silenceStart = 0;
  private hasSpeech = false;

  // Audio params: 16kHz, 16-bit signed LE, mono — qwen3-asr-server resamples internally.
  private readonly sampleRate = 16000;
  private readonly bytesPerSample = 2;
  private readonly bytesPerSecond = this.sampleRate * this.bytesPerSample;

  // Silence detection (matches whisper-local for parity)
  private readonly silenceThresholdRms = 150;
  private readonly silenceDurationMs = 500;
  private readonly minSpeechMs = 500;
  private readonly maxBufferSeconds = 30;

  constructor(
    /** OpenAI-compatible base URL, e.g. "http://192.168.1.116:8001/v1" */
    private endpoint: string,
    /** PipeWire source name to capture from */
    private pipewireSource: string,
    /** served-model-name to send in the multipart `model` field (default "qwen3-asr") */
    private model: string = "qwen3-asr",
    /** Language hint or "auto" */
    private language: string = "auto",
  ) {
    super();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Probe the endpoint — fail fast if unreachable
    await this.probeEndpoint(10000);

    this.startCapture();
    this.flushTimer = setInterval(() => this.checkFlush(), 500);

    logger.info(TAG, `Qwen ASR HTTP STT started (endpoint=${this.endpoint}, model=${this.model})`);
  }

  private async probeEndpoint(timeoutMs: number): Promise<void> {
    // Strip trailing /v1 if present, hit /health
    const baseUrl = this.endpoint.replace(/\/v1\/?$/, "");
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const resp = await fetch(`${baseUrl}/health`);
        if (resp.ok) {
          logger.info(TAG, `qwen3-asr endpoint is healthy at ${baseUrl}`);
          return;
        }
      } catch {
        // not ready
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`qwen3-asr endpoint did not respond at ${baseUrl}/health within ${timeoutMs}ms`);
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
      this.audioBuffer.push(chunk);
      this.bufferBytes += chunk.length;

      if (!this.silenceStart) {
        this.silenceStart = Date.now();
      } else if (Date.now() - this.silenceStart >= this.silenceDurationMs) {
        this.emit("speech_stopped");
        this.flushBuffer();
      }
    }

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

    logger.info(TAG, `Flushing ${durationMs.toFixed(0)}ms of audio (${pcm.length} bytes) to qwen3-asr`);

    try {
      const t0 = Date.now();
      const transcript = await this.transcribe(pcm);
      logger.info(TAG, `qwen3-asr returned in ${Date.now() - t0}ms: "${transcript}"`);
      if (transcript && transcript.trim()) {
        this.emit("transcript", transcript.trim());
      }
    } catch (err: any) {
      logger.error(TAG, `Transcription error: ${err.message}`);
    }
  }

  private async transcribe(pcm: Buffer): Promise<string> {
    const wav = this.pcmToWav(pcm);

    // Build multipart form by hand so we can use Node's native fetch.
    // Convert Buffer → Uint8Array because Node's Buffer's underlying
    // ArrayBufferLike includes SharedArrayBuffer which Blob won't accept.
    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "speech.wav");
    fd.append("model", this.model);
    if (this.language && this.language !== "auto") {
      fd.append("language", this.language);
    }

    const resp = await fetch(`${this.endpoint.replace(/\/$/, "")}/audio/transcriptions`, {
      method: "POST",
      body: fd,
      // 30 s upper bound — even a 30 s clip transcribes in ~2 s on Spark.
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "unknown");
      throw new Error(`qwen3-asr HTTP ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const json: any = await resp.json();
    return (json.text || "").trim();
  }

  private pcmToWav(pcm: Buffer): Buffer {
    const header = Buffer.alloc(44);
    const dataSize = pcm.length;
    const fileSize = 36 + dataSize;

    header.write("RIFF", 0);
    header.writeUInt32LE(fileSize, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(this.sampleRate, 24);
    header.writeUInt32LE(this.bytesPerSecond, 28);
    header.writeUInt16LE(this.bytesPerSample, 32);
    header.writeUInt16LE(16, 34);
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

    logger.info(TAG, "Qwen ASR HTTP STT stopped");
  }

  get isRunning(): boolean {
    return this.running;
  }
}
