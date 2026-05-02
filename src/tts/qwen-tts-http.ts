import { logger } from "../logger.js";

const TAG = "qwen-tts-http";

/**
 * Qwen3-TTS via the OpenAI-compatible HTTP endpoint exposed by
 * `aeon-7/qwen3-tts-server` (FastAPI wrapper around qwen-tts SDK; defaults
 * to Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign).
 *
 * Drop-in shape match for `ElevenLabsTTS`: `synthesize(text)` → PCM Buffer,
 * plus a `outputSampleRate` field the pipeline reads when invoking pw-play.
 *
 * Server returns WAV (24 kHz mono 16-bit by default). We strip the RIFF
 * header and return the raw PCM payload, plus we read the actual sample
 * rate from the WAV header so we don't hardcode 24 kHz on the client side
 * (future model variants may differ).
 *
 * `voice` is forwarded as the OpenAI `voice` param, which the
 * qwen3-tts-server maps to qwen-tts `instruct` — a free-form natural-
 * language voice description. Examples:
 *   - "A neutral, friendly adult voice with clear pronunciation."
 *   - "An elderly British man, gravelly and warm, slow and deliberate."
 *   - "A cheerful young woman with a slight French accent, energetic."
 *
 * RTF on DGX Spark hot path: ~1.30x real-time (1.48 s synthesis for ~2 s of
 * speech). Per-sentence streaming from voice-pipeline.ts means perceived
 * latency to first audio is ~the first sentence's wall time, not the full
 * response.
 */
export class QwenTtsHttpTTS {
  /**
   * Sample rate of the most recent synthesis. Initialized to 24 kHz (Qwen3-TTS
   * default) and updated from the WAV header on every synthesize() call.
   * voice-pipeline.ts reads this when launching pw-play.
   */
  public outputSampleRate = 24000;

  constructor(
    /** OpenAI-compatible base URL, e.g. "http://192.168.1.116:8002/v1" */
    private endpoint: string,
    /** Voice description (free-form). Forwarded to qwen-tts as `instruct`. */
    private voice: string = "A neutral, friendly adult voice with clear pronunciation, moderate pace, and natural intonation.",
    /** served-model-name (default "qwen3-tts"). */
    private model: string = "qwen3-tts",
    /** Optional language hint (zh/en/ja/ko/de/fr/ru/pt/es/it). Auto-detect if undefined. */
    private language?: string,
  ) {}

  async synthesize(text: string, _sampleRate: number = 24000): Promise<Buffer> {
    logger.debug(TAG, `Synthesizing ${text.length} chars (model=${this.model})`);
    const t0 = Date.now();

    const resp = await fetch(`${this.endpoint.replace(/\/$/, "")}/audio/speech`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "audio/wav",
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
        voice: this.voice,
        response_format: "wav",
        ...(this.language ? { language: this.language } : {}),
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "unknown");
      throw new Error(`qwen3-tts HTTP ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const wav = Buffer.from(await resp.arrayBuffer());
    if (wav.length < 44 || wav.subarray(0, 4).toString() !== "RIFF") {
      throw new Error(`qwen3-tts returned non-WAV bytes (length=${wav.length})`);
    }

    // Parse canonical WAV header — sample rate at offset 24, channels at 22,
    // and the `data` chunk header tells us where the PCM starts (chunks may
    // include LIST/INFO between fmt and data).
    const sampleRate = wav.readUInt32LE(24);
    const channels = wav.readUInt16LE(22);
    const dataIdx = wav.indexOf("data");
    if (dataIdx < 0) {
      throw new Error("qwen3-tts WAV missing 'data' chunk");
    }
    const pcmStart = dataIdx + 8;
    const pcm = wav.subarray(pcmStart);

    this.outputSampleRate = sampleRate;

    logger.info(
      TAG,
      `Synthesized ${text.length} chars in ${Date.now() - t0}ms → ${pcm.length} bytes PCM (${sampleRate}Hz, ${channels}ch)`
    );
    return pcm;
  }
}
