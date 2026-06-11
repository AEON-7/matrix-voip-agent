import sdk from "matrix-js-sdk";
import childProcess from "child_process";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { OmniClient } from "./llm/omni-client.js";
import { Config } from "./config.js";
import { logger } from "./logger.js";

const TAG = "voice-pipeline-omni";

interface TranscriptEntry {
  timestamp: string;
  speaker: "user" | "celina";
  text: string;
}

/**
 * Omni voice pipeline — sends raw audio to Qwen3-Omni, gets audio back.
 * No separate STT or TTS needed. The model handles everything natively.
 *
 * Flow:
 *   PipeWire capture -> energy VAD -> speech segment
 *     -> Qwen3-Omni (audio in, text+audio out)
 *     -> play audio via PipeWire + log text transcript
 */
export class OmniVoicePipeline {
  private omni: OmniClient;
  private running = false;
  private speaking = false;
  private processing = false;
  private recorder: childProcess.ChildProcess | null = null;
  private transcript: TranscriptEntry[] = [];
  private callStartTime: string;
  private callerDisplayName: string;

  // VAD state
  private audioChunks: Buffer[] = [];
  private silenceFrames = 0;
  private speechDetected = false;

  // VAD thresholds
  private readonly SILENCE_THRESHOLD = 200;  // RMS threshold for silence
  private readonly SILENCE_FRAMES_END = 25;  // ~800ms at ~31fps (16000Hz / 512 samples)
  private readonly MIN_SPEECH_BYTES = 16000;  // ~500ms minimum speech
  private readonly CAPTURE_RATE = 16000;

  constructor(
    private config: Config,
    private client: sdk.MatrixClient,
    private roomId: string,
    private callerUserId: string
  ) {
    this.callerDisplayName = config.calls.callerName || "caller";
    this.omni = new OmniClient(
      config.omni.baseUrl,
      config.omni.apiKey,
      config.omni.model,
      config.omni.speaker
    );
    this.callStartTime = new Date().toISOString();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.startCapture();
    logger.info(TAG, "Omni voice pipeline started (audio-native, no STT/TTS)");
  }

  private startCapture(): void {
    const { spawn } = childProcess;
    this.recorder = spawn("pw-record", [
      `--target=${this.config.pipewire.sttCapture}`,
      "--format=s16", `--rate=${this.CAPTURE_RATE}`, "--channels=1",
      "--latency=30ms", "-",
    ], { stdio: ["ignore", "pipe", "pipe"] });

    this.recorder.stdout?.on("data", (chunk: Buffer) => {
      if (this.running && !this.speaking && !this.processing) {
        this.processAudioChunk(chunk);
      }
    });

    this.recorder.on("exit", (code: number) => {
      if (this.running) {
        logger.warn(TAG, `pw-record exited (${code}), restarting...`);
        setTimeout(() => this.startCapture(), 500);
      }
    });
  }

  private processAudioChunk(chunk: Buffer): void {
    const rms = this.computeRMS(chunk);

    if (rms > this.SILENCE_THRESHOLD) {
      if (!this.speechDetected) {
        this.speechDetected = true;
        this.audioChunks = [];
        logger.debug(TAG, "Speech started");
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

        if (pcm.length >= this.MIN_SPEECH_BYTES) {
          logger.info(TAG, `Speech segment: ${pcm.length} bytes (${(pcm.length / (this.CAPTURE_RATE * 2)).toFixed(1)}s)`);
          this.handleSpeechSegment(pcm);
        } else {
          logger.debug(TAG, `Discarding short segment: ${pcm.length} bytes`);
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

  private async handleSpeechSegment(pcm: Buffer): Promise<void> {
    if (!this.running || this.processing) return;
    this.processing = true;

    try {
      const response = await this.omni.chat(pcm);

      this.transcript.push({
        timestamp: new Date().toISOString(),
        speaker: "user",
        text: "[audio]",
      });

      if (response.text) {
        this.transcript.push({
          timestamp: new Date().toISOString(),
          speaker: "celina",
          text: response.text,
        });
        logger.info(TAG, `Omni response: "${response.text.substring(0, 80)}..."`);
      }

      if (response.audio && response.audio.length > 0) {
        await this.playAudio(response.audio, response.sampleRate);
      }
      this.processing = false;
    } catch (err: any) {
      this.processing = false;
      logger.error(TAG, `Omni error: ${err.message}`);
    }
  }

  private playAudio(pcm: Buffer, sampleRate: number): Promise<void> {
    const { spawn } = childProcess;
    this.speaking = true;

    return new Promise((resolve, reject) => {
      const proc = spawn("pw-play", [
        `--target=${this.config.pipewire.ttsSink}`,
        "--format=s16",
        `--rate=${sampleRate}`,
        "--channels=1",
        "-",
      ], { stdio: ["pipe", "ignore", "pipe"] });

      proc.stderr?.on("data", (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) logger.warn(TAG, `pw-play stderr: ${msg}`);
      });

      proc.on("exit", (code: number) => {
        this.speaking = false;
        if (code === 0) resolve();
        else reject(new Error(`pw-play exited with ${code}`));
      });

      proc.on("error", (err) => {
        this.speaking = false;
        reject(err);
      });

      proc.stdin?.on("error", () => {}); // ignore EPIPE if pw-play exits early
      proc.stdin?.write(pcm, () => {
        proc.stdin?.end();
      });
    });
  }

  async speakGreeting(greeting: string): Promise<void> {
    try {
      const response = await this.omni.chatText(greeting);
      if (response.audio && response.audio.length > 0) {
        await this.playAudio(response.audio, response.sampleRate);
      }
      this.transcript.push({
        timestamp: new Date().toISOString(),
        speaker: "celina",
        text: response.text || greeting,
      });
    } catch (err: any) {
      logger.error(TAG, `Greeting failed: ${err.message}`);
    }
  }

  saveTranscript(): void {
    if (this.transcript.length === 0) return;

    try {
      const dir = join(process.env.HOME || "/tmp", "matrix-voip-agent", "transcripts");
      mkdirSync(dir, { recursive: true });

      const timestamp = this.callStartTime.replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
      const filename = `call-${timestamp}.md`;
      const filepath = join(dir, filename);

      let md = `# Voice Call Transcript (Omni Mode)\n\n`;
      md += `- **Date**: ${this.callStartTime}\n`;
      md += `- **Caller**: ${this.callerUserId}\n`;
      md += `- **Duration**: ${this.transcript.length} turns\n`;
      md += `- **Mode**: Qwen3-Omni (native audio)\n\n`;
      md += `---\n\n`;

      for (const entry of this.transcript) {
        const time = entry.timestamp.slice(11, 19);
        const speaker = entry.speaker === "user" ? `**${this.callerDisplayName}**` : "**Celina**";
        md += `[${time}] ${speaker}: ${entry.text}\n\n`;
      }

      writeFileSync(filepath, md);
      logger.info(TAG, `Transcript saved to ${filepath}`);

      const jsonPath = join(dir, `call-${timestamp}.json`);
      writeFileSync(jsonPath, JSON.stringify({
        callStart: this.callStartTime,
        caller: this.callerUserId,
        mode: "omni",
        transcript: this.transcript,
      }, null, 2));
    } catch (err: any) {
      logger.error(TAG, `Failed to save transcript: ${err.message}`);
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.saveTranscript();

    if (this.recorder) {
      try { this.recorder.kill("SIGTERM"); } catch {}
      this.recorder = null;
    }

    logger.info(TAG, "Omni voice pipeline stopped");
  }

  get isRunning(): boolean {
    return this.running;
  }
}
