import sdk from "matrix-js-sdk";
import childProcess from "child_process";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { WhisperLocalSTT } from "./stt/whisper-local.js";
import { MacASR } from "./stt/mac-asr.js";
import { OmniASR } from "./stt/omni-asr.js";
import { OpenAIRealtimeSTT } from "./stt/openai-realtime.js";
import { ElevenLabsTTS } from "./tts/elevenlabs.js";
import { VoxtralTTS, VoiceSynthesisContext } from "./tts/voxtral-tts.js";
import { VLLMClient, ChatMessage, ChatContentPart, buildVoiceSystemPrompt } from "./llm/vllm-client.js";
import { VoiceTool, VoiceToolRichResult } from "./tools/types.js";
import { BUILT_IN_TOOLS } from "./tools/built-in.js";
import { makeLookTool, jpegDataUrl } from "./tools/look.js";
import type { VideoFrameSource } from "./video/frame-sampler.js";
import { Config } from "./config.js";
import { loadVoiceMemoryContext } from "./memory-context.js";
import { logger } from "./logger.js";
import { Readable } from "node:stream";

const TAG = "voice-pipeline";

type STTBackend = WhisperLocalSTT | OpenAIRealtimeSTT | MacASR | OmniASR;

interface TranscriptEntry {
  timestamp: string;
  speaker: "user" | "celina";
  text: string;
}

/**
 * Direct voice pipeline — minimum latency path:
 *
 * Caller speaks → Whisper STT → transcript
 *   → vLLM (direct HTTP, streamed) → sentence chunks
 *   → ElevenLabs TTS (per sentence) → PipeWire → caller hears Celina
 *
 * No Matrix in the loop during the call. Transcript saved to file after hangup.
 */
export class VoicePipeline {
  private stt: STTBackend | null = null;
  private tts: ElevenLabsTTS | VoxtralTTS;
  private llm: VLLMClient;
  private running = false;
  private speaking = false;
  private processing = false;
  private pendingTranscript: string | null = null;
  private synthesisTail: Promise<void> = Promise.resolve();
  private speechTail: Promise<void> = Promise.resolve();
  private sttMode: "whisper" | "openai" | "omni" = "whisper";
  private openaiPwRecord: childProcess.ChildProcess | null = null;
  private currentTtsProc: childProcess.ChildProcess | null = null;
  private currentTtsStream: Readable | null = null;
  private tools: VoiceTool[] = BUILT_IN_TOOLS;

  // Conversation history for context
  private history: ChatMessage[] = [];
  private transcript: TranscriptEntry[] = [];
  private callStartTime: string;
  private callerDisplayName: string;

  constructor(
    private config: Config,
    private client: sdk.MatrixClient,
    private roomId: string,
    private callerUserId: string,
    private videoSource?: VideoFrameSource
  ) {
    this.callerDisplayName = config.calls.callerName || "caller";

    // Select TTS backend: Voxtral (local) or ElevenLabs (cloud)
    if (config.voxtral.enabled) {
      this.tts = new VoxtralTTS(
        config.voxtral.baseUrl,
        config.voxtral.voice,
        config.voxtral.model,
        config.voxtral.voiceDescription,
        config.voxtral.voiceStyleField,
        config.voxtral.language,
        config.voxtral.voiceStyleTemplate
      );
    } else {
      this.tts = new ElevenLabsTTS(
        config.elevenlabs.apiKey,
        config.elevenlabs.voiceId,
        config.elevenlabs.model
      );
    }

    const voiceStyle =
      " This is a live phone call. Keep replies concise and to the point, like a natural spoken conversation, usually one to three sentences. Speak in plain prose with no markdown, lists, code, or symbols. Only go deeper or more elaborate when the caller explicitly asks for detail, a story, planning, or step by step help.";
    const baseSystemPrompt = config.vllm.systemPrompt
      ? `${config.vllm.systemPrompt}\n\nThe caller's name is ${this.callerDisplayName}.${voiceStyle}`
      : buildVoiceSystemPrompt(this.callerDisplayName);
    const memoryContext = loadVoiceMemoryContext(config.voiceMemory);
    let systemPrompt = memoryContext
      ? `${baseSystemPrompt}\n\n${memoryContext}`
      : baseSystemPrompt;

    // Register the look tool only when this call actually has live video —
    // voice-only calls keep the exact tool list and prompt they had before.
    if (this.videoSource?.isActive()) {
      this.tools = [...BUILT_IN_TOOLS, makeLookTool(this.videoSource)];
      systemPrompt += `\nThe caller's camera is on: call the "look" tool whenever seeing the camera would help.`;
      logger.info(TAG, `Look tool registered (video call): tools = ${this.tools.map((t) => t.name).join(", ")}`);
    }

    this.llm = new VLLMClient(
      config.vllm.baseUrl,
      config.vllm.apiKey,
      config.vllm.model,
      systemPrompt
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
    // Try Nemotron Omni ASR first when enabled; keep Voxtral/ElevenLabs for TTS.
    if (process.env.OMNI_ASR_ENABLED === "true") {
      const omniAsrUrl = process.env.OMNI_ASR_BASE_URL || this.config.vllm.baseUrl;
      const omniAsrKey = process.env.OMNI_ASR_API_KEY || this.config.vllm.apiKey || "EMPTY";
      const omniAsrModel = process.env.OMNI_ASR_MODEL || this.config.vllm.model;
      try {
        const omniAsr = new OmniASR(omniAsrUrl, omniAsrKey, omniAsrModel, this.config.pipewire.sttCapture);
        await omniAsr.start();
        this.stt = omniAsr;
        this.sttMode = "omni";
        logger.info(TAG, `Using Nemotron Omni ASR for STT (${omniAsrModel})`);
        return;
      } catch (err: any) {
        logger.warn(TAG, `Nemotron Omni ASR failed: ${err.message}, trying MacBook ASR`);
      }
    }

    // Try MacBook ASR next (fast, dedicated fallback)
    const macAsrUrl = process.env.MAC_ASR_URL;
    const macAsrKey = process.env.MAC_ASR_API_KEY;
    const macAsrModel = process.env.MAC_ASR_MODEL || "Voxtral-Mini-4B-Realtime-2602-MLX-4bit";
    if (macAsrUrl && macAsrKey) {
      try {
        const macAsr = new MacASR(macAsrUrl, macAsrKey, this.config.pipewire.sttCapture, macAsrModel);
        await macAsr.start();
        this.stt = macAsr;
        this.sttMode = "whisper"; // reuse label for logging
        logger.info(TAG, "Using MacBook ASR for STT");
        return;
      } catch (err: any) {
        logger.warn(TAG, "MacBook ASR failed, trying local whisper");
      }
    }

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
   * Hot path: transcript arrives -> LLM -> TTS -> speaker.
   *
   * Full-response TTS uses the non-streaming, tool-capable chat path so the
   * model can act before we synthesize one complete utterance. Chunked mode
   * keeps the lower-latency streaming path, but that path cannot use tools.
   */
  private async handleTranscript(text: string): Promise<void> {
    if (!this.running) return;

    if (this.isIgnorableTranscript(text)) {
      logger.info(TAG, `Ignored non-actionable transcript: "${text.substring(0, 80)}"`);
      return;
    }

    if (this.speaking) {
      logger.info(TAG, `Dropped transcript during TTS playback: "${text.substring(0, 80)}"`);
      return;
    }

    if (this.processing) {
      this.pendingTranscript = text;
      logger.info(TAG, `Queued transcript while busy: "${text.substring(0, 80)}"`);
      return;
    }

    await this.processTranscript(text);
  }

  private isIgnorableTranscript(text: string): boolean {
    const normalized = text.trim().replace(/[。.!?,，、\s]/g, "");
    if (!normalized) return true;

    const lower = normalized.toLowerCase();
    if (/^(uh|um|umm|hmm|mm|mmm|ah|oh)$/.test(lower)) return true;

    // Qwen/Voxtral ASR sometimes emits short CJK filler from breathing,
    // room noise, or TTS bleed. Keep this deliberately narrow.
    if (/^[嗯啊呃额哦唔是好]+$/.test(normalized) && normalized.length <= 4) {
      return true;
    }

    return false;
  }

  private async processTranscript(text: string): Promise<void> {
    if (!this.running || this.processing) return;

    this.processing = true;
    const busyWarning = setTimeout(() => {
      logger.warn(TAG, "Turn still processing after 120s; keeping lock to prevent overlapping speech");
    }, 120000);
    const t0 = Date.now();
    logger.info(TAG, `[${this.sttMode}] ${this.callerDisplayName} said: "${text}"`);

    this.transcript.push({
      timestamp: new Date().toISOString(),
      speaker: "user",
      text,
    });

    try {
      const fullResponseTts = this.config.voiceOutput.ttsResponseMode === "full";

      if (fullResponseTts) {
        const enableThinking = this.shouldEnableThinking(text);
        this.history.push(this.buildUserMessage(text));

        // Deep (thinking) path is slower; speak a brief filler so the caller
        // is not left in silence while the model reasons.
        let thinkingFiller: Promise<void> | null = null;
        if (enableThinking) {
          const fillers = [
            "Let me think about that for a moment.",
            "Good question. Give me a second to think it through.",
            "Hmm, let me consider that for a moment.",
          ];
          const phrase = fillers[Math.floor(Math.random() * fillers.length)];
          logger.info(TAG, `Deep path thinking filler: "${phrase}"`);
          thinkingFiller = this.speakSentence(phrase);
        }

        const response = await this.llm.chat(this.history, this.tools, enableThinking);
        logger.info(
          TAG,
          `Full voice LLM response ready in ${Date.now() - t0}ms ` +
            `(mode=${enableThinking ? "deep" : "fast"}, tools=${response.toolCalls.length})`
        );

        if (thinkingFiller) await thinkingFiller;

        if (response.toolCalls.length > 0) {
          await this.handleToolCalls(response, t0, 0, (process.env.VLLM_VOICE_TOOLS_THINKING ?? "on") !== "off" || enableThinking);
        } else if (response.content.trim()) {
          await this.speakAndLog(response.content, t0);
        } else {
          // Thinking can consume the whole budget and leave content empty
          // (reasoning went to reasoning_content / hit the token limit) — which
          // would otherwise end the turn in SILENCE. Retry once on the FAST
          // path so the caller always gets a spoken answer.
          logger.warn(TAG, "Empty turn (likely thinking-only); retrying fast for a spoken answer");
          const retry = await this.llm.chat(this.history, this.tools, false);
          if (retry.toolCalls.length > 0) {
            await this.handleToolCalls(retry, t0, 0, false);
          } else if (retry.content.trim()) {
            await this.speakAndLog(retry.content, t0);
          } else {
            await this.speakAndLog("Sorry, I lost the thread there for a second. What were you asking?", t0);
          }
        }

        this.trimHistory();
        return;
      }

      let fullResponse = "";
      let sentenceCount = 0;
      const speechJobs: Promise<void>[] = [];

      for await (const sentence of this.llm.streamSentences(this.history, text)) {
        if (!this.running) break;
        fullResponse += sentence + " ";
        sentenceCount++;
        if (sentenceCount === 1) {
          logger.info(TAG, `First voice text chunk ready in ${Date.now() - t0}ms`);
        }

        // Queue speech while continuing to read the LLM stream. Playback stays ordered.
        speechJobs.push(this.speakSentence(sentence, {
          userText: text,
          turnText: `${fullResponse}${sentence}`,
          sentenceIndex: sentenceCount,
        }));
      }

      await Promise.all(speechJobs);

      if (fullResponse.trim()) {
        this.history.push({ role: "user", content: text });
        this.history.push({ role: "assistant", content: fullResponse.trim() });
        this.transcript.push({
          timestamp: new Date().toISOString(),
          speaker: "celina",
          text: fullResponse.trim(),
        });
        const totalMs = Date.now() - t0;
        logger.info(TAG, `Turn complete in ${totalMs}ms (${sentenceCount} sentences): "${fullResponse.substring(0, 80)}..."`);
      }

      this.trimHistory();
    } catch (err: any) {
      logger.error(TAG, `LLM/TTS error: ${err.message}`);
    } finally {
      clearTimeout(busyWarning);
      this.processing = false;

      const next = this.pendingTranscript;
      this.pendingTranscript = null;
      if (this.running && next) {
        setTimeout(() => this.handleTranscript(next).catch((err: any) => {
          logger.error(TAG, `Queued transcript error: ${err.message}`);
        }), 0);
      }
    }
  }

  private shouldEnableThinking(text: string): boolean {
    const mode = (process.env.VLLM_VOICE_THINKING_MODE || "auto").toLowerCase();
    if (["1", "true", "on", "always", "deep"].includes(mode)) return true;
    if (["0", "false", "off", "never", "fast"].includes(mode)) return false;

    const lower = text.toLowerCase();
    if (text.length > 1000) return true;
    // Reserved for genuinely challenging analysis (tool-call follow-ups think
    // separately via VLLM_VOICE_TOOLS_THINKING). Kept tight so casual chat
    // stays on the snappy fast path.
    return /\b(think hard|think this through|deep dive|reason through|work through|analy[sz]e|prove|derive|calculate)\b/.test(lower);
  }

  /**
   * Build the user turn message. With VIDEO_AUTO_ATTACH=latest and a live
   * camera, the freshest ring-buffer frame rides along as an image part.
   * The look tool remains the primary vision path; this mode trades tokens
   * for zero-latency visual context. Default is off.
   */
  private buildUserMessage(text: string): ChatMessage {
    if (this.config.video.autoAttach === "latest" && this.videoSource?.isActive()) {
      const [frame] = this.videoSource.getFrames(1);
      if (frame) {
        logger.info(TAG, "Auto-attaching latest camera frame to user turn");
        return {
          role: "user",
          content: [
            { type: "text", text },
            { type: "image_url", image_url: { url: jpegDataUrl(frame.jpeg) } },
          ],
        };
      }
    }
    return { role: "user", content: text };
  }

  private trimHistory(): void {
    // Camera frames are expensive (1-2k tokens each at 512px). Once the turn
    // that used them is over, collapse image parts to a text stub — the model
    // can always call look again for a fresh frame.
    for (const msg of this.history) {
      if (Array.isArray(msg.content)) {
        const text = msg.content
          .filter((p): p is Extract<ChatContentPart, { type: "text" }> => p.type === "text")
          .map((p) => p.text)
          .join("\n");
        const imageCount = msg.content.filter((p) => p.type === "image_url").length;
        msg.content = imageCount > 0
          ? `${text}\n[${imageCount} camera frame(s) omitted]`.trim()
          : text;
      }
    }

    const maxMessages = parseInt(process.env.VOICE_HISTORY_MAX_MESSAGES || "24", 10);
    const keepMessages = parseInt(process.env.VOICE_HISTORY_KEEP_MESSAGES || "12", 10);
    if (this.history.length > maxMessages) {
      this.history = this.history.slice(-keepMessages);
    }
  }

  /**
   * Handle tool calls: filler speech → execute → LLM follow-up
   */
  private async handleToolCalls(
    response: import("./llm/vllm-client.js").ChatResponse,
    t0: number,
    depth: number = 0,
    enableThinking: boolean = false
  ): Promise<void> {
    if (depth >= 3) {
      logger.warn(TAG, "Max tool call depth reached");
      await this.speakAndLog("I ran into a loop trying to process that. Let me just answer directly.", t0);
      return;
    }

    const toolCallIds = response.toolCalls.map(
      (tc, i) => tc.id || `call_${Date.now()}_${depth}_${i}`
    );

    // Add assistant message with tool calls to history
    this.history.push({
      role: "assistant",
      content: response.content || "",
      tool_calls: response.toolCalls.map((tc, i) => ({
        id: toolCallIds[i],
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
          tool_call_id: toolCallIds[i],
        });
        continue;
      }

      // Speak filler phrase while tool executes
      logger.info(TAG, `Tool call: ${tc.name}(${JSON.stringify(tc.arguments)}) — filler: "${tool.fillerPhrase}"`);
      const fillerPromise = this.speakSentence(tool.fillerPhrase);

      // Execute tool in parallel with filler speech
      const tTool = Date.now();
      let result: string | VoiceToolRichResult;
      try {
        result = await tool.execute(tc.arguments);

        // Special handling for send_message tool
        if (typeof result === "string" && result.startsWith("__SEND_MATRIX__:")) {
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

      const resultText = typeof result === "string" ? result : result.text;
      logger.info(TAG, `Tool ${tc.name} completed in ${Date.now() - tTool}ms: "${resultText.substring(0, 100)}"`);

      // Wait for filler to finish before speaking result
      await fillerPromise;

      this.pushToolResult(result, toolCallIds[i]);
    }

    // Call LLM again with tool results
    const followUp = await this.llm.chat(this.history, this.tools, enableThinking);

    if (followUp.toolCalls.length > 0) {
      await this.handleToolCalls(followUp, t0, depth + 1, enableThinking);
    } else if (followUp.content) {
      await this.speakAndLog(followUp.content, t0);
    }
  }

  /**
   * Push a tool result to history. Image-bearing results (the look tool)
   * become OpenAI image_url content parts.
   *
   * VIDEO_LOOK_IMAGE_ROLE=tool (default) puts the image parts directly in the
   * role:"tool" message. Set "user" if the model's chat template rejects
   * images inside tool messages — the tool message then carries only the text
   * and the frames ride in an immediately following user message.
   */
  private pushToolResult(result: string | VoiceToolRichResult, toolCallId: string): void {
    if (typeof result === "string" || !result.images?.length) {
      this.history.push({
        role: "tool",
        content: typeof result === "string" ? result : result.text,
        tool_call_id: toolCallId,
      });
      return;
    }

    const imageParts: ChatContentPart[] = result.images.map((jpeg) => ({
      type: "image_url",
      image_url: { url: jpegDataUrl(jpeg) },
    }));

    const imageRole = this.config.video.lookImageRole;
    if (imageRole === "user") {
      this.history.push({ role: "tool", content: result.text, tool_call_id: toolCallId });
      this.history.push({
        role: "user",
        content: [
          { type: "text", text: "[camera frames returned by the look tool]" },
          ...imageParts,
        ],
      });
    } else {
      this.history.push({
        role: "tool",
        content: [{ type: "text", text: result.text }, ...imageParts],
        tool_call_id: toolCallId,
      });
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

    if (this.config.voiceOutput.ttsResponseMode === "full") {
      await this.speakSentence(clean, {
        turnText: text,
        sentenceIndex: 1,
      });
    } else {
      // Split into sentences and speak each
      const sentences = clean.match(/[^.!?]+[.!?]+/g) || [clean];
      for (const sentence of sentences) {
        if (!this.running) break;
        const trimmed = sentence.trim();
        if (trimmed.length > 5) {
          await this.speakSentence(trimmed, {
            turnText: text,
          });
        }
      }
    }

    const totalMs = Date.now() - t0;
    logger.info(TAG, `Turn complete in ${totalMs}ms: "${text.substring(0, 80)}..."`);
  }

  async speakSentence(text: string, context: VoiceSynthesisContext = {}): Promise<void> {
    if (!this.running) return;

    const synthStarted = Date.now();
    const synthJob = this.synthesisTail.then(async () => {
      if (!this.running) return;
      const pcm = await this.synthesizeSpeech(text, context);
      logger.info(TAG, `Speech chunk synthesized in ${Date.now() - synthStarted}ms (${text.length} chars)`);
      return pcm;
    });

    this.synthesisTail = synthJob.then(
      () => undefined,
      () => undefined
    );

    const playJob = this.speechTail.then(async () => {
      let pcm: Buffer | Readable | undefined;
      try {
        pcm = await synthJob;
      } catch (err: any) {
        logger.error(TAG, `TTS error for sentence: ${err.message}`);
        return;
      }

      if (!this.running || !pcm) return;

      this.speaking = true;
      const playStarted = Date.now();
      try {
        await this.playToTTS(pcm);
        logger.info(TAG, `Speech chunk played in ${Date.now() - playStarted}ms (${text.length} chars)`);
      } catch (err: any) {
        logger.error(TAG, `TTS playback error for sentence: ${err.message}`);
      } finally {
        this.speaking = false;
      }
    });

    this.speechTail = playJob.then(
      () => undefined,
      () => undefined
    );

    await playJob;
  }

  private synthesizeSpeech(text: string, context: VoiceSynthesisContext): Promise<Buffer | Readable> {
    if (this.tts instanceof VoxtralTTS) {
      if (process.env.VOXTRAL_STREAMING === "true") {
        return this.tts.synthesizeStream(text, context);
      }
      return this.tts.synthesize(text, context);
    }
    return this.tts.synthesize(text);
  }

  private playToTTS(pcmOrStream: Buffer | Readable): Promise<void> {
    const { spawn } = childProcess;
    return new Promise((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const proc = spawn("pw-play", [
        `--target=${this.config.pipewire.ttsSink}`,
        "--format=s16",
        `--rate=${this.tts.outputSampleRate}`,
        "--channels=1",
        "-",
      ], { stdio: ["pipe", "ignore", "pipe"] });
      this.currentTtsProc = proc;

      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (this.currentTtsProc === proc) this.currentTtsProc = null;
        if (!Buffer.isBuffer(pcmOrStream) && this.currentTtsStream === pcmOrStream) {
          this.currentTtsStream = null;
        }
        if (err && this.running) reject(err);
        else resolve();
      };

      proc.stderr?.on("data", (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) logger.warn(TAG, `TTS pw-play stderr: ${msg}`);
      });

      proc.on("exit", (code: number) => {
        if (code === 0 || !this.running) finish();
        else finish(new Error(`pw-play exited with ${code}`));
      });

      proc.on("error", (err) => finish(err));

      proc.stdin?.on("error", () => {}); // ignore EPIPE if pw-play exits early

      const timeoutMs = parseInt(process.env.VOXTRAL_PLAYBACK_TIMEOUT_MS || "90000", 10);
      timeout = setTimeout(() => {
        const err = new Error(`TTS playback timed out after ${timeoutMs}ms`);
        if (!Buffer.isBuffer(pcmOrStream)) pcmOrStream.destroy(err);
        proc.stdin?.destroy();
        try { proc.kill("SIGTERM"); } catch {}
        setTimeout(() => {
          try { proc.kill("SIGKILL"); } catch {}
        }, 1000).unref?.();
        finish(err);
      }, timeoutMs);
      timeout.unref?.();

      if (Buffer.isBuffer(pcmOrStream)) {
        proc.stdin?.write(pcmOrStream, () => {
          proc.stdin?.end();
        });
      } else if (proc.stdin) {
        this.currentTtsStream = pcmOrStream;
        pcmOrStream.once("error", (err) => {
          proc.stdin?.destroy();
          finish(err instanceof Error ? err : new Error(String(err)));
        });
        pcmOrStream.once("close", () => {
          if (!this.running) finish();
        });
        // Streaming TTS: pipe chunks straight into pw-play stdin as they arrive
        pcmOrStream.pipe(proc.stdin);
      }
    });
  }

  private cancelCurrentTtsPlayback(): void {
    const stream = this.currentTtsStream;
    this.currentTtsStream = null;
    if (stream) {
      stream.destroy();
    }

    const proc = this.currentTtsProc;
    this.currentTtsProc = null;
    if (proc) {
      try { proc.stdin?.destroy(); } catch {}
      try { proc.kill("SIGTERM"); } catch {}
      setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch {}
      }, 1000).unref?.();
    }
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
        const speaker = entry.speaker === "user" ? `**${this.callerDisplayName}**` : "**Celina**";
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
    this.cancelCurrentTtsPlayback();

    // Save transcript before cleanup
    this.saveTranscript();

    // Stop STT
    if (this.stt) {
      if (this.stt instanceof WhisperLocalSTT) {
        this.stt.stop();
      } else if (this.stt instanceof MacASR) {
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
