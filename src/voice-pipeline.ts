import sdk from "matrix-js-sdk";
import childProcess from "child_process";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { WhisperLocalSTT } from "./stt/whisper-local.js";
import { OpenAIRealtimeSTT } from "./stt/openai-realtime.js";
import { ElevenLabsTTS } from "./tts/elevenlabs.js";
import { VLLMClient, ChatMessage, VOICE_SYSTEM_PROMPT } from "./llm/vllm-client.js";
import { Config } from "./config.js";
import { logger } from "./logger.js";

const TAG = "voice-pipeline";

type STTBackend = WhisperLocalSTT | OpenAIRealtimeSTT;

interface TranscriptEntry {
  timestamp: string;
  speaker: "user" | "celina";
  text: string;
}

/**
 * Direct voice pipeline — minimum latency path:
 *
 * Albert speaks → Whisper STT → transcript
 *   → vLLM (direct HTTP, streamed) → sentence chunks
 *   → ElevenLabs TTS (per sentence) → PipeWire → Albert hears Celina
 *
 * No Matrix in the loop during the call. Transcript saved to file after hangup.
 */
export class VoicePipeline {
  private stt: STTBackend | null = null;
  private tts: ElevenLabsTTS;
  private llm: VLLMClient;
  private running = false;
  private speaking = false;
  private sttMode: "whisper" | "openai" = "whisper";
  private openaiPwRecord: childProcess.ChildProcess | null = null;

  // Conversation history for context
  private history: ChatMessage[] = [];
  private transcript: TranscriptEntry[] = [];
  private callStartTime: string;

  constructor(
    private config: Config,
    private client: sdk.MatrixClient,
    private roomId: string,
    private callerUserId: string
  ) {
    this.tts = new ElevenLabsTTS(
      config.elevenlabs.apiKey,
      config.elevenlabs.voiceId,
      config.elevenlabs.model
    );

    this.llm = new VLLMClient(
      config.vllm.baseUrl,
      config.vllm.apiKey,
      config.vllm.model,
      config.vllm.systemPrompt || VOICE_SYSTEM_PROMPT
    );

    this.callStartTime = new Date().toISOString();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Start STT — prefer local whisper, fall back to OpenAI
    await this.startSTT();

    // Wire transcript events — this is the hot path
    this.stt!.on("transcript", (text: string) => this.handleTranscript(text));
    this.stt!.on("speech_started", () => logger.debug(TAG, "Caller started speaking"));

    logger.info(TAG, `Voice pipeline started (STT: ${this.sttMode}, LLM: direct vLLM)`);
  }

  private async startSTT(): Promise<void> {
    if (this.config.whisper.enabled) {
      try {
        const whisper = new WhisperLocalSTT(
          this.config.whisper.serverUrl,
          this.config.pipewire.sttCapture,
          this.config.whisper.serverBin,
          this.config.whisper.modelPath,
          this.config.whisper.vadModelPath,
          this.config.whisper.language,
          this.config.whisper.autoStartServer,
          this.config.whisper.serverPort
        );
        await whisper.start();
        this.stt = whisper;
        this.sttMode = "whisper";
        logger.info(TAG, "Using local whisper.cpp for STT");
        return;
      } catch (err: any) {
        logger.warn(TAG, `Local whisper failed: ${err.message}, trying OpenAI fallback`);
      }
    }

    if (this.config.openai.apiKey) {
      const openai = new OpenAIRealtimeSTT(
        this.config.openai.apiKey,
        this.config.openai.sttModel
      );
      await openai.connect();
      this.startOpenAICapture(openai);
      this.stt = openai;
      this.sttMode = "openai";
      logger.info(TAG, "Using OpenAI Realtime for STT (fallback)");
      return;
    }

    throw new Error("No STT backend available");
  }

  private startOpenAICapture(stt: OpenAIRealtimeSTT): void {
    const { spawn } = childProcess;
    this.openaiPwRecord = spawn("pw-record", [
      `--target=${this.config.pipewire.sttCapture}`,
      "--format=s16", "--rate=24000", "--channels=1", "--latency=20ms", "-",
    ], { stdio: ["ignore", "pipe", "pipe"] });

    this.openaiPwRecord!.stdout?.on("data", (chunk: Buffer) => {
      if (this.running && stt.isConnected) stt.sendAudio(chunk);
    });

    this.openaiPwRecord!.on("exit", (code: number) => {
      if (this.running && this.sttMode === "openai") {
        setTimeout(() => this.startOpenAICapture(stt), 1000);
      }
    });
  }

  /**
   * Hot path: transcript arrives → LLM → TTS → speaker
   * Target: < 12 seconds from end of speech to first audio
   */
  private async handleTranscript(text: string): Promise<void> {
    if (!this.running) return;
    const t0 = Date.now();
    logger.info(TAG, `[${this.sttMode}] Albert said: "${text}"`);

    // Log to transcript
    this.transcript.push({
      timestamp: new Date().toISOString(),
      speaker: "user",
      text,
    });

    // Add to conversation history
    this.history.push({ role: "user", content: text });

    try {
      // Stream LLM response sentence by sentence
      let fullResponse = "";

      for await (const sentence of this.llm.streamSentences(this.history, text)) {
        if (!this.running) break;

        fullResponse += (fullResponse ? " " : "") + sentence;
        const tLLM = Date.now();
        logger.info(TAG, `LLM sentence (${tLLM - t0}ms): "${sentence}"`);

        // TTS this sentence immediately — don't wait for the full response
        await this.speakSentence(sentence);
      }

      // Add full response to history
      if (fullResponse) {
        this.history.push({ role: "assistant", content: fullResponse });
        this.transcript.push({
          timestamp: new Date().toISOString(),
          speaker: "celina",
          text: fullResponse,
        });

        const totalMs = Date.now() - t0;
        logger.info(TAG, `Turn complete in ${totalMs}ms: "${fullResponse.substring(0, 80)}..."`);
      }

      // Keep history manageable (last 20 turns)
      if (this.history.length > 40) {
        this.history = this.history.slice(-20);
      }
    } catch (err: any) {
      logger.error(TAG, `LLM/TTS error: ${err.message}`);
    }
  }

  private async speakSentence(text: string): Promise<void> {
    if (!this.running) return;

    // Wait if already speaking
    const waitStart = Date.now();
    while (this.speaking && this.running && Date.now() - waitStart < 30000) {
      await new Promise(r => setTimeout(r, 100));
    }
    if (!this.running) return;

    this.speaking = true;
    try {
      const pcm = await this.tts.synthesize(text);
      if (!this.running) return;
      await this.playToTTS(pcm);
    } catch (err: any) {
      logger.error(TAG, `TTS error for sentence: ${err.message}`);
    } finally {
      this.speaking = false;
    }
  }

  private playToTTS(pcm: Buffer): Promise<void> {
    const { spawn } = childProcess;
    return new Promise((resolve, reject) => {
      const proc = spawn("pw-play", [
        `--target=${this.config.pipewire.ttsSink}`,
        "--format=s16",
        `--rate=${this.tts.outputSampleRate}`,
        "--channels=1",
        "-",
      ], { stdio: ["pipe", "ignore", "pipe"] });

      proc.stderr?.on("data", (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) logger.warn(TAG, `TTS pw-play stderr: ${msg}`);
      });

      proc.on("exit", (code: number) => {
        if (code === 0) resolve();
        else reject(new Error(`pw-play exited with ${code}`));
      });

      proc.on("error", reject);

      proc.stdin?.write(pcm, () => {
        proc.stdin?.end();
      });
    });
  }

  /**
   * Save call transcript and audio log after hangup.
   */
  saveTranscript(): void {
    if (this.transcript.length === 0) return;

    try {
      const dir = join(process.env.HOME || "/tmp", "matrix-voip-agent", "transcripts");
      mkdirSync(dir, { recursive: true });

      const timestamp = this.callStartTime.replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
      const filename = `call-${timestamp}.md`;
      const filepath = join(dir, filename);

      let md = `# Voice Call Transcript\n\n`;
      md += `- **Date**: ${this.callStartTime}\n`;
      md += `- **Caller**: ${this.callerUserId}\n`;
      md += `- **Duration**: ${this.transcript.length} turns\n`;
      md += `- **STT**: ${this.sttMode}\n\n`;
      md += `---\n\n`;

      for (const entry of this.transcript) {
        const time = entry.timestamp.slice(11, 19);
        const speaker = entry.speaker === "user" ? "**Albert**" : "**Celina**";
        md += `[${time}] ${speaker}: ${entry.text}\n\n`;
      }

      writeFileSync(filepath, md);
      logger.info(TAG, `Transcript saved to ${filepath}`);

      // Also save as JSON for programmatic access
      const jsonPath = join(dir, `call-${timestamp}.json`);
      writeFileSync(jsonPath, JSON.stringify({
        callStart: this.callStartTime,
        caller: this.callerUserId,
        sttMode: this.sttMode,
        transcript: this.transcript,
      }, null, 2));
      logger.info(TAG, `JSON transcript saved to ${jsonPath}`);
    } catch (err: any) {
      logger.error(TAG, `Failed to save transcript: ${err.message}`);
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    // Save transcript before cleanup
    this.saveTranscript();

    // Stop STT
    if (this.stt) {
      if (this.stt instanceof WhisperLocalSTT) {
        this.stt.stop();
      } else {
        (this.stt as OpenAIRealtimeSTT).disconnect();
      }
      this.stt = null;
    }

    if (this.openaiPwRecord) {
      try { this.openaiPwRecord.kill("SIGTERM"); } catch {}
      this.openaiPwRecord = null;
    }

    logger.info(TAG, "Voice pipeline stopped");
  }

  get isRunning(): boolean {
    return this.running;
  }
}
