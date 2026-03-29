import { logger } from "../logger.js";

const TAG = "elevenlabs-tts";

/**
 * ElevenLabs TTS - converts text to PCM audio.
 * Returns raw PCM 16-bit signed LE at the requested sample rate.
 */
export class ElevenLabsTTS {
  constructor(
    private apiKey: string,
    private voiceId: string,
    private model: string = "eleven_flash_v2_5"
  ) {}

  /**
   * Synthesize text to PCM audio buffer.
   * @param text - Text to speak
   * @param sampleRate - Output sample rate (default 24000)
   * @returns PCM 16-bit signed LE mono buffer
   */
  // Actual output sample rate after synthesis (ElevenLabs free tier only supports up to 24kHz PCM)
  public readonly outputSampleRate = 24000;

  async synthesize(text: string, _sampleRate: number = 24000): Promise<Buffer> {
    // Always use pcm_24000 — it's available on all tiers.
    // PipeWire handles resampling to 48kHz for WebRTC.
    const outputFormat = "pcm_24000";

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/stream?output_format=${outputFormat}`;

    logger.debug(TAG, `Synthesizing ${text.length} chars with model=${this.model}`);

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": this.apiKey,
        "Content-Type": "application/json",
        Accept: "audio/pcm",
      },
      body: JSON.stringify({
        text,
        model_id: this.model,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true,
        },
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "unknown");
      throw new Error(`ElevenLabs API error ${resp.status}: ${errText}`);
    }

    const arrayBuf = await resp.arrayBuffer();
    const pcm = Buffer.from(arrayBuf);

    logger.info(TAG, `Synthesized ${text.length} chars → ${pcm.length} bytes PCM (${this.outputSampleRate}Hz)`);
    return pcm;
  }
}
