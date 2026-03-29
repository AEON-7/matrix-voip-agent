import sdk from "matrix-js-sdk";
import childProcess from "child_process";
import { EventEmitter } from "events";
import { WhisperLocalSTT } from "./stt/whisper-local.js";
import { OpenAIRealtimeSTT } from "./stt/openai-realtime.js";
import { ElevenLabsTTS } from "./tts/elevenlabs.js";
import { Config } from "./config.js";
import { logger } from "./logger.js";

const TAG = "voice-pipeline";

type STTBackend = WhisperLocalSTT | OpenAIRealtimeSTT;

/**
 * Full voice pipeline for a Matrix VoIP call:
 *
 * Albert speaks → PipeWire → Whisper (local, primary) or OpenAI (fallback) → transcript
 *   → Matrix message → Celina responds → ElevenLabs TTS → PipeWire → Albert hears
 */
export class VoicePipeline {
  private stt: STTBackend | null = null;
  private tts: ElevenLabsTTS;
  private running = false;
  private speaking = false;
  private sttMode: "whisper" | "openai" = "whisper";
  private timelineHandler: ((event: sdk.MatrixEvent, room: sdk.Room | undefined, ...args: any[]) => void) | null = null;

  private bridgeClient: sdk.MatrixClient | null = null;

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
  }

  private async getBridgeClient(): Promise<sdk.MatrixClient> {
    if (this.bridgeClient) return this.bridgeClient;

    if (!this.config.bridge.accessToken) {
      // No bridge account configured — fall back to main client
      logger.warn(TAG, "No BRIDGE_ACCESS_TOKEN — transcripts will be sent as Celina");
      return this.client;
    }

    const bridgeClient = sdk.createClient({
      baseUrl: this.config.matrix.homeserverUrl,
      accessToken: this.config.bridge.accessToken,
      userId: this.config.bridge.userId,
    });

    // Join the room if not already joined
    try {
      await bridgeClient.joinRoom(this.roomId);
      logger.info(TAG, `Bridge account joined room ${this.roomId}`);
    } catch {
      // Already joined or invite needed
    }

    this.bridgeClient = bridgeClient;
    return bridgeClient;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // 1. Start STT — prefer local whisper, fall back to OpenAI
    await this.startSTT();

    // 2. Wire transcript events
    this.stt!.on("transcript", (text: string) => this.handleTranscript(text));
    this.stt!.on("speech_started", () => logger.debug(TAG, "Caller started speaking"));

    // 3. Listen for Celina's responses in the room
    this.timelineHandler = (event: sdk.MatrixEvent, room: sdk.Room | undefined) => {
      if (room?.roomId === this.roomId) {
        this.handleRoomEvent(event);
      }
    };
    this.client.on(sdk.RoomEvent.Timeline, this.timelineHandler);

    logger.info(TAG, `Voice pipeline started (STT: ${this.sttMode})`);
  }

  private async startSTT(): Promise<void> {
    // Try local whisper first
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

    // Fallback to OpenAI Realtime
    if (this.config.openai.apiKey) {
      const openai = new OpenAIRealtimeSTT(
        this.config.openai.apiKey,
        this.config.openai.sttModel
      );
      await openai.connect();

      // OpenAI Realtime needs us to pipe audio to it
      this.startOpenAICapture(openai);

      this.stt = openai;
      this.sttMode = "openai";
      logger.info(TAG, "Using OpenAI Realtime for STT (fallback)");
      return;
    }

    throw new Error("No STT backend available — set WHISPER_ENABLED=true or provide OPENAI_API_KEY");
  }

  private openaiPwRecord: import("child_process").ChildProcess | null = null;

  private startOpenAICapture(stt: OpenAIRealtimeSTT): void {
    const { spawn } = childProcess;
    this.openaiPwRecord = spawn("pw-record", [
      `--target=${this.config.pipewire.sttCapture}`,
      "--format=s16",
      "--rate=24000",
      "--channels=1",
      "--latency=20ms",
      "-",
    ], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.openaiPwRecord!.stdout?.on("data", (chunk: Buffer) => {
      if (!this.running || !stt.isConnected) return;
      stt.sendAudio(chunk);
    });

    this.openaiPwRecord!.on("exit", (code: number) => {
      logger.info(TAG, `OpenAI pw-record exited with code ${code}`);
      if (this.running && this.sttMode === "openai") {
        setTimeout(() => this.startOpenAICapture(stt), 1000);
      }
    });
  }

  private async handleTranscript(text: string): Promise<void> {
    if (!this.running) return;
    logger.info(TAG, `[${this.sttMode}] Albert said: "${text}"`);

    try {
      // Send transcript to OpenClaw agent via gateway CLI (async — must not block event loop)
      const escaped = text.replace(/'/g, "'\\''");
      const proc = childProcess.spawn("openclaw", [
        "agent", "-m", text,
        "--channel", "matrix",
        "--to", this.callerUserId,
        "--deliver",
        "--timeout", "120",
      ], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 130000,
      });

      proc.stdout?.on("data", (d: Buffer) => {
        logger.debug(TAG, `openclaw agent stdout: ${d.toString().trim()}`);
      });
      proc.stderr?.on("data", (d: Buffer) => {
        logger.debug(TAG, `openclaw agent stderr: ${d.toString().trim()}`);
      });
      proc.on("exit", (code) => {
        if (code === 0) {
          logger.info(TAG, "OpenClaw agent delivered response");
        } else {
          logger.warn(TAG, `openclaw agent exited with code ${code}`);
        }
      });

      logger.info(TAG, "Sent voice transcript to OpenClaw agent (async)");
    } catch (err: any) {
      logger.error(TAG, `Failed to send transcript to agent: ${err.message}`);
    }
  }

  private handleRoomEvent(event: sdk.MatrixEvent): void {
    if (!this.running) return;

    const sender = event.getSender();
    const type = event.getType();

    // Only process text messages from the bot (Celina)
    if (sender !== this.config.matrix.userId) return;
    if (type !== "m.room.message") return;

    const content = event.getContent();
    if (content.msgtype !== "m.text") return;
    if ((content as any)["io.openclaw.voice_transcript"]) return;

    const responseText = content.body;
    if (!responseText?.trim()) return;

    logger.info(TAG, `Celina responded: "${responseText.substring(0, 80)}..."`);
    this.speakResponse(responseText);
  }

  private async speakResponse(text: string): Promise<void> {
    if (!this.running || this.speaking) return;
    this.speaking = true;

    try {
      const pcm = await this.tts.synthesize(text, 48000);
      if (!this.running) return;
      await this.playToTTS(pcm);
      logger.info(TAG, "Finished speaking response");
    } catch (err: any) {
      logger.error(TAG, `TTS error: ${err.message}`);
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
        "--rate=48000",
        "--channels=1",
        "-",
      ], {
        stdio: ["pipe", "ignore", "pipe"],
      });

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

  stop(): void {
    if (!this.running) return;
    this.running = false;

    // Stop STT
    if (this.stt) {
      if (this.stt instanceof WhisperLocalSTT) {
        this.stt.stop();
      } else {
        (this.stt as OpenAIRealtimeSTT).disconnect();
      }
      this.stt = null;
    }

    // Stop OpenAI pw-record if active
    if (this.openaiPwRecord) {
      try { this.openaiPwRecord.kill("SIGTERM"); } catch {}
      this.openaiPwRecord = null;
    }

    // Remove Matrix listener
    if (this.timelineHandler) {
      this.client.removeListener(sdk.RoomEvent.Timeline, this.timelineHandler as any);
      this.timelineHandler = null;
    }

    logger.info(TAG, "Voice pipeline stopped");
  }

  get isRunning(): boolean {
    return this.running;
  }
}
