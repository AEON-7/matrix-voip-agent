import WebSocket from "ws";
import { EventEmitter } from "events";
import { logger } from "../logger.js";

const TAG = "openai-stt";

/**
 * OpenAI Realtime API for streaming speech-to-text.
 * Sends raw PCM audio, receives transcriptions.
 */
export class OpenAIRealtimeSTT extends EventEmitter {
  private ws: WebSocket | null = null;
  private connected = false;

  constructor(
    private apiKey: string,
    private model: string = "gpt-4o-mini-transcribe"
  ) {
    super();
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `wss://api.openai.com/v1/realtime?intent=transcription&model=${this.model}`;

      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });

      this.ws.on("open", () => {
        logger.info(TAG, "Connected to OpenAI Realtime API");
        this.connected = true;

        // Configure the session for transcription
        this.ws!.send(JSON.stringify({
          type: "transcription_session.update",
          session: {
            input_audio_format: "pcm16",
            input_audio_transcription: {
              model: this.model,
              language: "en",
            },
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 800,
            },
          },
        }));

        resolve();
      });

      this.ws.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(msg);
        } catch {
          logger.debug(TAG, "Failed to parse message");
        }
      });

      this.ws.on("error", (err) => {
        logger.error(TAG, `WebSocket error: ${err.message}`);
        if (!this.connected) reject(err);
      });

      this.ws.on("close", (code, reason) => {
        logger.info(TAG, `WebSocket closed: ${code} ${reason}`);
        this.connected = false;
        this.emit("disconnected");
      });
    });
  }

  /**
   * Send raw PCM audio (16-bit signed LE, 24kHz, mono).
   */
  sendAudio(pcm: Buffer): void {
    if (!this.connected || !this.ws) return;

    this.ws.send(JSON.stringify({
      type: "input_audio_buffer.append",
      audio: pcm.toString("base64"),
    }));
  }

  private handleMessage(msg: any): void {
    switch (msg.type) {
      case "conversation.item.input_audio_transcription.completed":
        if (msg.transcript && msg.transcript.trim()) {
          logger.info(TAG, `Transcript: "${msg.transcript.trim()}"`);
          this.emit("transcript", msg.transcript.trim());
        }
        break;

      case "conversation.item.input_audio_transcription.delta":
        if (msg.delta) {
          this.emit("partial", msg.delta);
        }
        break;

      case "input_audio_buffer.speech_started":
        logger.debug(TAG, "Speech started");
        this.emit("speech_started");
        break;

      case "input_audio_buffer.speech_stopped":
        logger.debug(TAG, "Speech stopped");
        this.emit("speech_stopped");
        break;

      case "error":
        logger.error(TAG, `API error: ${JSON.stringify(msg.error)}`);
        break;

      case "transcription_session.created":
      case "transcription_session.updated":
        logger.info(TAG, `Session ${msg.type}`);
        break;
    }
  }

  disconnect(): void {
    this.connected = false;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  get isConnected(): boolean {
    return this.connected;
  }
}
