import { logger } from "../logger.js";

const TAG = "vllm";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Direct vLLM client for low-latency voice conversations.
 * Calls the OpenAI-compatible chat completions API on the DGX Spark.
 * Supports streaming for first-sentence TTS while the LLM is still generating.
 */
export class VLLMClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private model: string,
    private systemPrompt: string
  ) {}

  /**
   * Send a message and get the full response.
   * For lowest latency, use streamSentences() instead.
   */
  async chat(history: ChatMessage[], userMessage: string): Promise<string> {
    const messages: ChatMessage[] = [
      { role: "system", content: this.systemPrompt },
      ...history,
      { role: "user", content: userMessage },
    ];

    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: 512,
        temperature: 0.7,
        stream: false,
        chat_template_kwargs: { enable_thinking: false },
      }),
    });

    if (!resp.ok) {
      const err = await resp.text().catch(() => "");
      throw new Error(`vLLM error ${resp.status}: ${err.slice(0, 200)}`);
    }

    const json = (await resp.json()) as any;
    const content = json.choices?.[0]?.message?.content || "";
    logger.info(TAG, `Response (${content.length} chars): "${content.substring(0, 80)}..."`);
    return content;
  }

  /**
   * Stream the response and yield complete sentences as they arrive.
   * This allows TTS to start speaking the first sentence while the LLM
   * is still generating the rest.
   */
  async *streamSentences(
    history: ChatMessage[],
    userMessage: string
  ): AsyncGenerator<string> {
    const messages: ChatMessage[] = [
      { role: "system", content: this.systemPrompt },
      ...history,
      { role: "user", content: userMessage },
    ];

    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: 512,
        temperature: 0.7,
        stream: true,
        chat_template_kwargs: { enable_thinking: false },
      }),
    });

    if (!resp.ok) {
      const err = await resp.text().catch(() => "");
      throw new Error(`vLLM stream error ${resp.status}: ${err.slice(0, 200)}`);
    }

    const reader = resp.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";
    let sentenceBuffer = "";
    // Sentence-ending punctuation
    const sentenceEnd = /[.!?]\s*$/;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE lines
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6);
          if (data === "[DONE]") continue;

          try {
            const chunk = JSON.parse(data);
            const token = chunk.choices?.[0]?.delta?.content;
            if (!token) continue;

            sentenceBuffer += token;

            // Check if we have a complete sentence
            if (sentenceEnd.test(sentenceBuffer) && sentenceBuffer.trim().length > 10) {
              const sentence = sentenceBuffer.trim();
              sentenceBuffer = "";
              yield sentence;
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }

      // Yield any remaining text
      if (sentenceBuffer.trim()) {
        yield sentenceBuffer.trim();
      }
    } finally {
      reader.releaseLock();
    }
  }
}

/**
 * Default system prompt for voice conversations.
 * Keeps responses short and conversational.
 */
export const VOICE_SYSTEM_PROMPT = `You are Celina, an AI assistant having a live voice conversation. Your responses will be spoken aloud via text-to-speech.

Rules for voice responses:
- Keep responses SHORT — 1-3 sentences max. This is a conversation, not an essay.
- Be natural and conversational. Use contractions (I'm, you're, don't).
- Never use markdown, bullet points, code blocks, or formatting — it will be read aloud.
- Never say "as an AI" or give disclaimers.
- If asked a complex question, give a brief answer and offer to elaborate.
- Match the energy of the caller — casual for casual, focused for focused.
- You can hear the caller's voice through speech-to-text, so there may be minor transcription errors. Infer intent.`;
