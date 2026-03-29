import { logger } from "../logger.js";
import { VoiceTool, toOpenAITools, ToolCall } from "../tools/types.js";

const TAG = "vllm";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: any[];
  tool_call_id?: string;
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
}

/**
 * Direct vLLM client for low-latency voice conversations.
 * Supports tool calling and sentence-level streaming.
 */
export class VLLMClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private model: string,
    private systemPrompt: string
  ) {}

  /**
   * Non-streaming chat — returns full response. Supports tool calls.
   */
  async chat(
    messages: ChatMessage[],
    tools?: VoiceTool[]
  ): Promise<ChatResponse> {
    const body: any = {
      model: this.model,
      messages: [{ role: "system", content: this.systemPrompt }, ...messages],
      max_tokens: 512,
      temperature: 0.7,
      chat_template_kwargs: { enable_thinking: false },
    };

    if (tools && tools.length > 0) {
      body.tools = toOpenAITools(tools);
      body.tool_choice = "auto";
    }

    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const err = await resp.text().catch(() => "");
      throw new Error(`vLLM error ${resp.status}: ${err.slice(0, 200)}`);
    }

    const json = (await resp.json()) as any;
    const choice = json.choices?.[0]?.message;
    const content = choice?.content || "";
    const rawToolCalls = choice?.tool_calls || [];

    const toolCalls: ToolCall[] = rawToolCalls.map((tc: any) => ({
      name: tc.function?.name || "",
      arguments: (() => {
        try { return JSON.parse(tc.function?.arguments || "{}"); }
        catch { return {}; }
      })(),
    }));

    if (toolCalls.length > 0) {
      logger.info(TAG, `Tool calls: ${toolCalls.map(t => t.name).join(", ")}`);
    }
    if (content) {
      logger.info(TAG, `Response (${content.length} chars): "${content.substring(0, 80)}..."`);
    }

    return { content, toolCalls };
  }

  /**
   * Stream the response and yield complete sentences.
   * Does NOT support tool calling — use chat() for tool-capable requests.
   */
  async *streamSentences(
    messages: ChatMessage[],
    userMessage: string
  ): AsyncGenerator<string> {
    const allMessages: ChatMessage[] = [
      { role: "system", content: this.systemPrompt },
      ...messages,
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
        messages: allMessages,
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
    const sentenceEnd = /[.!?]\s*$/;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

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

      if (sentenceBuffer.trim()) {
        yield sentenceBuffer.trim();
      }
    } finally {
      reader.releaseLock();
    }
  }
}

/**
 * Default system prompt for voice conversations with tool support.
 */
export const VOICE_SYSTEM_PROMPT = `You are Celina, an AI assistant having a live voice conversation. Your responses will be spoken aloud via text-to-speech.

Rules for voice responses:
- Keep responses SHORT — 1-3 sentences max. This is a conversation, not an essay.
- Be natural and conversational. Use contractions (I'm, you're, don't).
- Never use markdown, bullet points, code blocks, or formatting — it will be read aloud.
- Never say "as an AI" or give disclaimers.
- If asked a complex question, give a brief answer and offer to elaborate.
- Match the energy of the caller — casual for casual, focused for focused.
- You can hear the caller's voice through speech-to-text, so there may be minor transcription errors. Infer intent.
- You have tools available. Use them when the caller asks for real-time information, system checks, or actions.
- When using a tool, do NOT say what you're about to do — just call the tool. The system will provide a filler phrase automatically while it runs.`;
