import { logger } from "../logger.js";
import { Readable } from "node:stream";

const TAG = "voxtral-tts";

type VoiceStyleField = "instructions" | "prompt" | "instruct" | "none";

export interface VoiceSynthesisContext {
  userText?: string;
  turnText?: string;
  sentenceIndex?: number;
}

/**
 * OpenAI-compatible /v1/audio/speech client.
 * Supports simple voice IDs and Qwen3-TTS VoiceDesign-style natural-language
 * delivery instructions through a configurable request field.
 * Returns raw PCM 16-bit signed LE at 24000 Hz.
 */
export class VoxtralTTS {
  public readonly outputSampleRate = 24000;
  private readonly voiceStyleField: VoiceStyleField;

  constructor(
    private baseUrl: string,
    private voice: string = "casual_female",
    private model: string = "Voxtral-4B-TTS-2603-mlx-4bit",
    private voiceDescription: string = "",
    voiceStyleField: string = "instructions",
    private language: string = "English",
    private voiceStyleTemplate: string = ""
  ) {
    this.voiceStyleField = this.normalizeVoiceStyleField(voiceStyleField);
  }

  async synthesize(text: string, context: VoiceSynthesisContext = {}): Promise<Buffer> {
    const url = `${this.baseUrl}/audio/speech`;
    const instructions = this.buildVoiceInstructions(text, context);
    const body: Record<string, unknown> = {
      model: this.model,
      input: text,
      voice: this.voice,
      speed: 1.0,
      response_format: 'wav',
    };

    const numericSeed = parseInt(process.env.VOXTRAL_TTS_SEED || "0", 10);
    if (numericSeed > 0) {
      body.seed = numericSeed;
    }
    this.applyVoiceCloneOptions(body);

    if (instructions && this.voiceStyleField !== "none") {
      body[this.voiceStyleField] = instructions;
      if (this.language) body.language = this.language;
    }

    logger.debug(
      TAG,
      `Synthesizing ${text.length} chars voice=${this.voice} model=${this.model} style=${Boolean(instructions)}`
    );

    const controller = new AbortController();
    const timeoutMs = parseInt(process.env.VOXTRAL_TTS_TIMEOUT_MS || "120000", 10);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (process.env.VOXTRAL_API_KEY) {
        headers.Authorization = `Bearer ${process.env.VOXTRAL_API_KEY}`;
      }

      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "unknown");
        throw new Error(`TTS error ${resp.status}: ${errText}`);
      }

      const arrayBuf = await resp.arrayBuffer();
      const wavBuf = Buffer.from(arrayBuf);

      // Extract PCM from WAV (skip header, find data chunk).
      let pcm = wavBuf;
      if (wavBuf.length > 44 && wavBuf.toString("ascii", 0, 4) === "RIFF") {
        for (let i = 0; i < wavBuf.length - 8; i++) {
          if (wavBuf.toString("ascii", i, i + 4) === "data") {
            const dataLen = wavBuf.readUInt32LE(i + 4);
            pcm = wavBuf.subarray(i + 8, i + 8 + dataLen);
            break;
          }
        }
      }

      logger.info(TAG, `Synthesized ${text.length} chars -> ${pcm.length} bytes PCM`);
      return pcm;
    } finally {
      clearTimeout(timeout);
    }
  }

  async synthesizeStream(text: string, context: VoiceSynthesisContext = {}): Promise<Readable> {
    const url = `${this.baseUrl}/audio/speech`;
    const instructions = this.buildVoiceInstructions(text, context);
    const body: Record<string, unknown> = {
      model: this.model,
      input: text,
      voice: this.voice,
      speed: 1.0,
      stream: true,
      response_format: "pcm",
    };

    const numericSeed = parseInt(process.env.VOXTRAL_TTS_SEED || "0", 10);
    if (numericSeed > 0) {
      body.seed = numericSeed;
    }
    this.applyVoiceCloneOptions(body);

    if (instructions && this.voiceStyleField !== "none") {
      body[this.voiceStyleField] = instructions;
      if (this.language) body.language = this.language;
    }

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (process.env.VOXTRAL_API_KEY) {
      headers.Authorization = `Bearer ${process.env.VOXTRAL_API_KEY}`;
    }

    logger.debug(
      TAG,
      `Streaming TTS ${text.length} chars voice=${this.voice} model=${this.model} style=${Boolean(instructions)}`
    );

    const controller = new AbortController();
    const timeoutMs = parseInt(process.env.VOXTRAL_TTS_TIMEOUT_MS || "120000", 10);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "unknown");
        throw new Error(`TTS stream error ${resp.status}: ${errText}`);
      }
      if (!resp.body) throw new Error("TTS response has no body");

      const stream = Readable.fromWeb(resp.body as any);
      const clear = () => clearTimeout(timeout);
      stream.once("end", clear);
      stream.once("close", clear);
      stream.once("error", clear);
      return stream;
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  }

  private normalizeVoiceStyleField(value: string): VoiceStyleField {
    const normalized = value.trim().toLowerCase();
    if (normalized === "prompt" || normalized === "instruct" || normalized === "none") {
      return normalized;
    }
    return "instructions";
  }

  private applyVoiceCloneOptions(body: Record<string, unknown>): void {
    const mode = (process.env.VOXTRAL_TTS_MODE || "").trim();
    const refAudio = (
      process.env.VOXTRAL_VOICE_CLONE_REF_AUDIO ||
      process.env.VOXTRAL_REF_AUDIO ||
      ""
    ).trim();
    const refText = (
      process.env.VOXTRAL_VOICE_CLONE_REF_TEXT ||
      process.env.VOXTRAL_REF_TEXT ||
      ""
    ).trim();

    if (mode) body.mode = mode;
    const maxNewTokens = parseInt(process.env.VOXTRAL_TTS_MAX_NEW_TOKENS || "0", 10);
    if (maxNewTokens > 0) body.max_new_tokens = maxNewTokens;
    if (refAudio) body.ref_audio = refAudio;
    if (refText) body.ref_text = refText;

    this.applyOptionalBool(body, "xvec_only", process.env.VOXTRAL_VOICE_CLONE_XVEC_ONLY);
    this.applyOptionalBool(body, "append_silence", process.env.VOXTRAL_VOICE_CLONE_APPEND_SILENCE);
  }

  private applyOptionalBool(body: Record<string, unknown>, key: string, value: string | undefined): void {
    if (value === undefined || value.trim() === "") return;
    body[key] = !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
  }

  private buildVoiceInstructions(text: string, context: VoiceSynthesisContext): string | undefined {
    const voice = this.voiceDescription.trim();
    if (!voice) return undefined;

    const seedInfo = (process.env.VOXTRAL_VOICE_SEED_INFO || "").trim();
    const direction = this.describeDelivery(text, context);
    const delivery = [
      `Tone tags: ${direction.tags.join(", ")}`,
      `Delivery: ${direction.delivery}`,
      `Prosody: ${direction.prosody}`,
    ].join("\n");

    const template = this.voiceStyleTemplate.trim();
    if (template) {
      let value = this.replaceToken(
        this.replaceToken(
          this.replaceToken(template, "{voice}", voice),
          "{delivery}",
          delivery
        ),
        "{text}",
        text.slice(0, 500)
      );
      value = this.replaceToken(value, "{tone}", direction.tags.join(", "));
      value = this.replaceToken(value, "{user}", (context.userText || "").slice(0, 500));
      value = this.replaceToken(value, "{seed}", seedInfo);
      return value;
    }

    const lines = [
      `Voice identity: ${voice}`,
      seedInfo ? `Voice continuity seed: ${seedInfo}` : undefined,
      "Keep the same speaker identity, timbre, accent, age impression, and natural conversational presence across the call.",
      "Only vary the emotional delivery, intonation, energy, pacing, breath, and emphasis to fit this exact moment.",
      context.userText ? `User just said: ${context.userText.slice(0, 500)}` : undefined,
      `Assistant line to speak: ${text.slice(0, 500)}`,
      delivery,
      "Do not redesign the speaker into a new person. Do not add, remove, or change any spoken text.",
    ].filter(Boolean) as string[];

    return lines.join("\n");
  }

  private describeDelivery(text: string, context: VoiceSynthesisContext): {
    tags: string[];
    delivery: string;
    prosody: string;
  } {
    const trimmed = text.trim();
    const lower = trimmed.toLowerCase();
    const userLower = (context.userText || "").toLowerCase();
    const combined = `${userLower}\n${lower}`;

    if (/\b(whisper|quiet|secret|softly|low voice)\b/.test(combined)) {
      return {
        tags: ["whispering", "mysterious", "intimate"],
        delivery: "soft and close, like a confidential aside, with breathy warmth but clear articulation",
        prosody: "low volume, slower pacing, gentle emphasis, no dramatic volume jumps",
      };
    }
    if (/[!?]{2,}/.test(trimmed) || /\b(amazing|awesome|great|yes|wow|fantastic|hell yes|love it)\b/.test(combined)) {
      return {
        tags: ["happy", "upbeat", "expressive"],
        delivery: "bright, delighted, and energized without becoming frantic",
        prosody: "slightly quicker pace, lively intonation, smiling tone, lifted phrase endings",
      };
    }
    if (/\b(i love|love you|proud of you|i care|with you|for you|together)\b/.test(combined)) {
      return {
        tags: ["loving", "warm", "passionate"],
        delivery: "tender, emotionally present, and openly affectionate while staying grounded",
        prosody: "warm resonance, slower pacing, gentle emphasis on caring words",
      };
    }
    if (/\b(sensual|intimate|beautiful|close|soft|touch|desire)\b/.test(combined)) {
      return {
        tags: ["sensual", "warm", "expressive"],
        delivery: "smooth, intimate, and low-lit, with playful warmth rather than theatrical seduction",
        prosody: "slower cadence, soft attack on consonants, relaxed pauses, controlled breath",
      };
    }
    if (/\b(sad|hurt|lonely|grief|loss|miss|pain|hard day|bad day)\b/.test(combined)) {
      return {
        tags: ["sad", "loving", "gentle"],
        delivery: "soft, compassionate, and emotionally steady, giving space to the feeling",
        prosody: "lower energy, slower pacing, longer pauses, softened endings",
      };
    }
    if (/\b(confused|wait|what do you mean|not sure|lost|unclear|huh)\b/.test(combined)) {
      return {
        tags: ["confused", "curious", "gentle"],
        delivery: "lightly puzzled but engaged, inviting clarification without sounding lost",
        prosody: "slight upward inflection, measured pace, careful emphasis on uncertainty",
      };
    }
    if (/\?$/.test(trimmed) || /\b(how|why|what if|could we|can we|tell me more)\b/.test(combined)) {
      return {
        tags: ["curious", "engaged", "expressive"],
        delivery: "curious and attentive, leaning into the question with interest",
        prosody: "gentle upward question intonation, medium pace, attentive pauses",
      };
    }
    if (/\b(mystic|mystical|cosmic|dream|soul|ritual|synchronicity|mysterious)\b/.test(combined)) {
      return {
        tags: ["mystical", "mysterious", "expressive"],
        delivery: "quietly enchanted and atmospheric, as if opening a door to something meaningful",
        prosody: "slow, smooth phrasing, subtle awe, airy pauses, restrained intensity",
      };
    }
    if (/\b(angry|mad|furious|unacceptable|bullshit|pissed)\b/.test(combined)) {
      return {
        tags: ["angry", "serious", "controlled"],
        delivery: "controlled anger with protective intensity, never shrill or chaotic",
        prosody: "firmer attack, lower pitch, clipped emphasis, deliberate pacing",
      };
    }
    if (/\b(careful|important|make sure|risk|warning|avoid|do not|don't|must|critical)\b/.test(combined)) {
      return {
        tags: ["serious", "stern", "professional"],
        delivery: "clear, grounded, and deliberate, with calm authority",
        prosody: "steady pace, firmer emphasis on important words, minimal ornament",
      };
    }
    if (/\b(urgent|tense|pressure|deadline|crash|broken|failing|problem|issue)\b/.test(combined)) {
      return {
        tags: ["tense", "focused", "professional"],
        delivery: "focused and alert, acknowledging pressure without amplifying panic",
        prosody: "quick but controlled cadence, crisp articulation, tight pauses",
      };
    }
    if (/\b(obviously|come on|honestly|please|really\?|look,|let's be real)\b/.test(combined)) {
      return {
        tags: ["sassy", "playful", "confident"],
        delivery: "playfully sassy and confident, with warmth underneath",
        prosody: "light eyebrow-raise energy, quick timing, playful emphasis",
      };
    }
    if (/\b(code|server|config|model|endpoint|docker|benchmark|latency|github|repo|api|matrix|openclaw)\b/.test(combined)) {
      return {
        tags: ["professional", "focused", "precise"],
        delivery: "focused and precise, with crisp technical confidence",
        prosody: "clear articulation, medium-fast pace, even volume, clean pauses",
      };
    }
    if (/\b(shout|shouting|loud|yell|scream)\b/.test(combined) || /[A-Z]{8,}/.test(trimmed)) {
      return {
        tags: ["shouting", "upbeat", "strong"],
        delivery: "raised energy and strong projection without clipping or harshness",
        prosody: "higher volume impression, wider pitch movement, emphatic rhythm",
      };
    }
    if (trimmed.length < 45) {
      return {
        tags: ["natural", "responsive"],
        delivery: "natural and responsive, like a quick conversational aside",
        prosody: "short, clean, lightly expressive",
      };
    }
    return {
      tags: ["expressive", "warm", "conversational"],
      delivery: "natural, expressive, and conversational, with emotional contour that follows the meaning",
      prosody: "smooth pacing, subtle pitch variation, warm presence, clear articulation",
    };
  }

  private replaceToken(value: string, token: string, replacement: string): string {
    return value.split(token).join(replacement);
  }
}
