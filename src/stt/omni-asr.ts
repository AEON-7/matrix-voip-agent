import { EventEmitter } from "events";
import childProcess from "child_process";
import { logger } from "../logger.js";

const TAG = "omni-asr";

/**
 * Nemotron Omni ASR client.
 * Captures audio from PipeWire, segments it with energy VAD, and sends WAV
 * data to the OpenAI-compatible multimodal chat endpoint for transcription.
 */
export class OmniASR extends EventEmitter {
  private recorder: childProcess.ChildProcess | null = null;
  private running = false;
  private transcribing = false;

  private audioChunks: Buffer[] = [];
  private silenceFrames = 0;
  private speechDetected = false;

  private readonly SILENCE_THRESHOLD = 180;
  private readonly SILENCE_FRAMES_END = 12;
  private readonly MIN_SPEECH_BYTES = 6400;
  private readonly CAPTURE_RATE = 16000;

  constructor(
    private baseUrl: string,
    private apiKey: string,
    private model: string,
    private captureSource: string
  ) {
    super();
  }

  async start(): Promise<void> {
    this.running = true;
    this.startCapture();
    logger.info(TAG, `Nemotron Omni ASR started (${this.baseUrl}, model=${this.model})`);
  }

  private startCapture(): void {
    const { spawn } = childProcess;
    this.recorder = spawn("pw-record", [
      `--target=${this.captureSource}`,
      "--format=s16",
      `--rate=${this.CAPTURE_RATE}`,
      "--channels=1",
      "--latency=20ms",
      "-",
    ], { stdio: ["ignore", "pipe", "pipe"] });

    this.recorder.stdout?.on("data", (chunk: Buffer) => {
      if (this.running) this.processAudioChunk(chunk);
    });

    this.recorder.stderr?.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) logger.warn(TAG, `pw-record stderr: ${msg}`);
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
    const t0 = Date.now();
    try {
      const wav = this.pcmToWav(pcm, this.CAPTURE_RATE);
      const body = {
        model: this.model,
        messages: [
          {
            role: "system",
            content: "You are an ASR engine. Transcribe only the user's spoken words. If there is no clear speech, return an empty string. Do not explain.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Transcribe this audio exactly. Return only the transcript text." },
              { type: "audio_url", audio_url: { url: `data:audio/wav;base64,${wav.toString("base64")}` } },
            ],
          },
        ],
        modalities: ["text"],
        max_tokens: 128,
        temperature: 0,
      };

      const resp = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey || "EMPTY"}`,
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "unknown");
        logger.error(TAG, `ASR error ${resp.status}: ${errText}`);
        return;
      }

      const result: any = await resp.json();
      const raw = result.choices?.[0]?.message?.content || "";
      const text = this.cleanTranscript(raw);
      const elapsed = Date.now() - t0;
      if (text) {
        logger.info(TAG, `Transcribed in ${elapsed}ms: "${text}"`);
        this.emit("transcript", text);
      } else {
        logger.debug(TAG, `No transcript from ${pcm.length} bytes audio (${elapsed}ms)`);
      }
    } catch (err: any) {
      logger.error(TAG, `Transcription failed: ${err.message}`);
    } finally {
      this.transcribing = false;
    }
  }

  private cleanTranscript(raw: string): string {
    let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    const marker = "</think>";
    const idx = text.lastIndexOf(marker);
    if (idx >= 0) text = text.slice(idx + marker.length).trim();
    text = text
      .replace(/^transcript\s*:\s*/i, "")
      .replace(/^the transcript is\s*:?\s*/i, "")
      .replace(/^['"]|['"]$/g, "")
      .trim();
    // Drop empty-speech markers + known qwen3-ASR silence-HALLUCINATIONS.
    // qwen3-ASR (heavily Chinese-trained) reflexively emits famous phrases on silent /
    // low-energy chunks — most notoriously "A Chinese Odyssey" (大話西遊 / Stephen Chow),
    // alongside Spanish "Ahora" and the YouTube-training-data family ("thanks for
    // watching", "subscribe"). Same bug class as Whisper's silent-YouTube artifacts.
    const norm = text.replace(/[.,!?;:'"\s]+$/u, "").trim();
    if (/^(\[?no speech\]?|\[?silence\]?|silence|no clear speech|a chinese odyssey|大[話话]西[遊游]|thanks? for watching|please subscribe|like and subscribe|thank you for watching|subscribe to my channel|bye[ -]?bye|ahora)$/i.test(norm)) {
      // eslint-disable-next-line no-console
      console.warn(`[${TAG}] dropped likely silence-hallucination: ${JSON.stringify(text)}`);
      return "";
    }
    return text;
  }

  private pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
    const header = Buffer.alloc(44);
    const dataLen = pcm.length;
    header.write("RIFF", 0);
    header.writeUInt32LE(dataLen + 36, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(dataLen, 40);
    return Buffer.concat([header, pcm]);
  }

  stop(): void {
    this.running = false;
    if (this.recorder) {
      try { this.recorder.kill("SIGTERM"); } catch {}
      this.recorder = null;
    }
    logger.info(TAG, "Nemotron Omni ASR stopped");
  }
}
