import { logger } from "../logger.js";

const TAG = "omni-client";

export interface OmniResponse {
  text: string;
  audio: Buffer | null;
  sampleRate: number;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | Array<{ type: string; text?: string; audio_url?: { url: string } }>;
}

/**
 * Audio-native LLM client for Qwen3-Omni.
 * Sends audio in, gets text + audio out — no separate STT or TTS needed.
 */
export class OmniClient {
  private history: ChatMessage[] = [];

  constructor(
    private baseUrl: string,
    private apiKey: string,
    private model: string,
    private speaker: string = "chelsie"
  ) {}

  /**
   * Send a PCM audio segment to the omni model and get text + audio back.
   * @param pcm - 16-bit signed LE mono PCM at 16000 Hz
   * @returns text (for transcript) + audio PCM buffer (for playback)
   */
  async chat(pcm: Buffer): Promise<OmniResponse> {
    // Encode PCM to WAV for the API
    const wav = this.pcmToWav(pcm, 16000);
    const b64 = wav.toString("base64");

    // Build message with audio content
    const userMsg: ChatMessage = {
      role: "user",
      content: [
        { type: "audio_url", audio_url: { url: `data:audio/wav;base64,${b64}` } },
      ],
    };

    // Keep history as text-only for context (avoid sending old audio)
    const messages: any[] = [
      {
        role: "system",
        content: [{ type: "text", text: "You are Qwen, a virtual human. You can perceive and generate audio. You are having a voice conversation. Keep responses concise and conversational." }],
      },
      ...this.history.map((m) => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : m.content,
      })),
      {
        role: "user",
        content: userMsg.content,
      },
    ];

    const body = {
      model: this.model,
      messages,
      modalities: ["text", "audio"],
      speaker: this.speaker,
      max_tokens: 512,
    };

    logger.debug(TAG, `Sending ${pcm.length} bytes audio to omni model`);
    const t0 = Date.now();

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
      throw new Error(`Omni API error ${resp.status}: ${errText}`);
    }

    const data: any = await resp.json();
    const elapsed = Date.now() - t0;

    let text = "";
    let audioBuf: Buffer | null = null;

    for (const choice of data.choices || []) {
      const msg = choice.message;
      if (msg?.content && typeof msg.content === "string") {
        text = msg.content;
      }
      if (msg?.audio?.data) {
        // Decode base64 WAV response
        const wavBuf = Buffer.from(msg.audio.data, "base64");
        audioBuf = this.wavToPcm(wavBuf);
      }
    }

    // Add to history as text for context
    if (text) {
      this.history.push({ role: "user", content: "[audio input]" });
      this.history.push({ role: "assistant", content: text });
    }

    // Keep history manageable
    if (this.history.length > 30) {
      this.history = this.history.slice(-20);
    }

    logger.info(TAG, `Omni response in ${elapsed}ms: "${text.substring(0, 80)}..." audio=${audioBuf ? audioBuf.length : 0} bytes`);

    return {
      text: text || "[no text response]",
      audio: audioBuf,
      sampleRate: 24000, // Qwen3-Omni outputs 24kHz audio
    };
  }

  /**
   * Send a text-only message (for greetings, tool responses, etc.)
   */
  async chatText(text: string): Promise<OmniResponse> {
    const messages: any[] = [
      {
        role: "system",
        content: [{ type: "text", text: "You are Qwen, a virtual human. Keep responses concise and conversational." }],
      },
      ...this.history.map((m) => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : m.content,
      })),
      { role: "user", content: text },
    ];

    const body = {
      model: this.model,
      messages,
      modalities: ["text", "audio"],
      speaker: this.speaker,
      max_tokens: 512,
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
      throw new Error(`Omni API error ${resp.status}: ${errText}`);
    }

    const data: any = await resp.json();

    let responseText = "";
    let audioBuf: Buffer | null = null;

    for (const choice of data.choices || []) {
      const msg = choice.message;
      if (msg?.content && typeof msg.content === "string") {
        responseText = msg.content;
      }
      if (msg?.audio?.data) {
        audioBuf = this.wavToPcm(Buffer.from(msg.audio.data, "base64"));
      }
    }

    this.history.push({ role: "user", content: text });
    if (responseText) {
      this.history.push({ role: "assistant", content: responseText });
    }

    return {
      text: responseText || "[no text response]",
      audio: audioBuf,
      sampleRate: 24000,
    };
  }

  /** Encode raw PCM to WAV format */
  private pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
    const header = Buffer.alloc(44);
    const dataLen = pcm.length;
    const fileLen = dataLen + 36;

    header.write("RIFF", 0);
    header.writeUInt32LE(fileLen, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);       // fmt chunk size
    header.writeUInt16LE(1, 20);        // PCM format
    header.writeUInt16LE(1, 22);        // mono
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28); // byte rate
    header.writeUInt16LE(2, 32);        // block align
    header.writeUInt16LE(16, 34);       // bits per sample
    header.write("data", 36);
    header.writeUInt32LE(dataLen, 40);

    return Buffer.concat([header, pcm]);
  }

  /** Extract raw PCM from WAV buffer (skip 44-byte header) */
  private wavToPcm(wav: Buffer): Buffer {
    // Find "data" chunk
    for (let i = 0; i < wav.length - 8; i++) {
      if (wav.toString("ascii", i, i + 4) === "data") {
        const dataLen = wav.readUInt32LE(i + 4);
        return wav.subarray(i + 8, i + 8 + dataLen);
      }
    }
    // Fallback: assume standard 44-byte header
    return wav.subarray(44);
  }
}
