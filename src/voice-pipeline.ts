import sdk from "matrix-js-sdk";
import childProcess from "child_process";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { WhisperLocalSTT } from "./stt/whisper-local.js";
import { OpenAIRealtimeSTT } from "./stt/openai-realtime.js";
import { ElevenLabsTTS } from "./tts/elevenlabs.js";
import { VLLMClient, ChatMessage, VOICE_SYSTEM_PROMPT } from "./llm/vllm-client.js";
import { VoiceTool } from "./tools/types.js";
import { BUILT_IN_TOOLS } from "./tools/built-in.js";
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
  private tools: VoiceTool[] = BUILT_IN_TOOLS;

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
   * Hot path: transcript arrives → LLM (with tools) → TTS → speaker
   *
   * Flow:
   * 1. First call: non-streaming with tools enabled
   * 2. If tool call → speak filler → execute tool → call LLM again with result
   * 3. If text response → stream it sentence by sentence with TTS
   * 4. Max 3 tool rounds to prevent infinite loops
   */
  private async handleTranscript(text: string): Promise<void> {
    if (!this.running) return;
    const t0 = Date.now();
    logger.info(TAG, `[${this.sttMode}] Albert said: "${text}"`);

    this.transcript.push({
      timestamp: new Date().toISOString(),
      speaker: "user",
      text,
    });

    this.history.push({ role: "user", content: text });

    try {
      // First, try non-streaming with tools to detect tool calls
      const response = await this.llm.chat(this.history, this.tools);

      if (response.toolCalls.length > 0) {
        // Tool call path — filler speech + execute + follow up
        await this.handleToolCalls(response, t0);
      } else if (response.content) {
        // Direct text response — speak it
        await this.speakAndLog(response.content, t0);
      }

      // Keep history manageable
      if (this.history.length > 40) {
        this.history = this.history.slice(-20);
      }
    } catch (err: any) {
      logger.error(TAG, `LLM/TTS error: ${err.message}`);
    }
  }

  /**
   * Handle tool calls: filler speech → execute → LLM follow-up
   */
  private async handleToolCalls(
    response: import("./llm/vllm-client.js").ChatResponse,
    t0: number,
    depth: number = 0
  ): Promise<void> {
    if (depth >= 3) {
      logger.warn(TAG, "Max tool call depth reached");
      await this.speakAndLog("I ran into a loop trying to process that. Let me just answer directly.", t0);
      return;
    }

    // Add assistant message with tool calls to history
    this.history.push({
      role: "assistant",
      content: response.content || "",
      tool_calls: response.toolCalls.map((tc, i) => ({
        id: `call_${Date.now()}_${i}`,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    });

    for (let i = 0; i < response.toolCalls.length; i++) {
      const tc = response.toolCalls[i];
      const tool = this.tools.find(t => t.name === tc.name);

      if (!tool) {
        logger.warn(TAG, `Unknown tool: ${tc.name}`);
        this.history.push({
          role: "tool",
          content: `Error: unknown tool "${tc.name}"`,
          tool_call_id: `call_${Date.now()}_${i}`,
        });
        continue;
      }

      // Speak filler phrase while tool executes
      logger.info(TAG, `Tool call: ${tc.name}(${JSON.stringify(tc.arguments)}) — filler: "${tool.fillerPhrase}"`);
      const fillerPromise = this.speakSentence(tool.fillerPhrase);

      // Execute tool in parallel with filler speech
      const tTool = Date.now();
      let result: string;
      try {
        result = await tool.execute(tc.arguments);

        // Special handling for send_message tool
        if (result.startsWith("__SEND_MATRIX__:")) {
          const msg = result.slice("__SEND_MATRIX__:".length);
          try {
            await this.client.sendMessage(this.roomId, { msgtype: "m.text", body: msg } as any);
            result = `Message sent to chat: "${msg}"`;
          } catch (err: any) {
            result = `Failed to send message: ${err.message}`;
          }
        }
      } catch (err: any) {
        result = `Tool error: ${err.message}`;
      }

      logger.info(TAG, `Tool ${tc.name} completed in ${Date.now() - tTool}ms: "${result.substring(0, 100)}"`);

      // Wait for filler to finish before speaking result
      await fillerPromise;

      this.history.push({
        role: "tool",
        content: result,
        tool_call_id: `call_${Date.now()}_${i}`,
      });
    }

    // Call LLM again with tool results
    const followUp = await this.llm.chat(this.history, this.tools);

    if (followUp.toolCalls.length > 0) {
      await this.handleToolCalls(followUp, t0, depth + 1);
    } else if (followUp.content) {
      await this.speakAndLog(followUp.content, t0);
    }
  }

  /**
   * Speak text and log to transcript
   */
  private async speakAndLog(text: string, t0: number): Promise<void> {
    // Strip markdown for TTS
    const clean = text
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/\*(.+?)\*/g, "$1")
      .replace(/`(.+?)`/g, "$1")
      .replace(/```[\s\S]*?```/g, "")
      .replace(/#{1,6}\s/g, "")
      .replace(/\[(.+?)\]\(.+?\)/g, "$1")
      .trim();

    if (!clean) return;

    this.history.push({ role: "assistant", content: text });
    this.transcript.push({
      timestamp: new Date().toISOString(),
      speaker: "celina",
      text,
    });

    // Split into sentences and speak each
    const sentences = clean.match(/[^.!?]+[.!?]+/g) || [clean];
    for (const sentence of sentences) {
      if (!this.running) break;
      const trimmed = sentence.trim();
      if (trimmed.length > 5) {
        await this.speakSentence(trimmed);
      }
    }

    const totalMs = Date.now() - t0;
    logger.info(TAG, `Turn complete in ${totalMs}ms: "${text.substring(0, 80)}..."`);
  }

  async speakSentence(text: string): Promise<void> {
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
