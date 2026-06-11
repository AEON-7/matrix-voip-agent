import { logger } from "../logger.js";
import { VoiceTool, toOpenAITools, ToolCall } from "../tools/types.js";

const TAG = "vllm";

/** OpenAI-style content part — vLLM accepts image_url parts (vision models). */
export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[];
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

  private modelForMode(enableThinking: boolean): string {
    const fastModel = process.env.VLLM_VOICE_FAST_MODEL || this.model;
    const deepModel = process.env.VLLM_VOICE_DEEP_MODEL || fastModel;
    return enableThinking ? deepModel : fastModel;
  }

  /**
   * Non-streaming chat — returns full response. Supports tool calls.
   */
  async chat(
    messages: ChatMessage[],
    tools?: VoiceTool[],
    enableThinking: boolean = false
  ): Promise<ChatResponse> {
    const standardMaxTokens = parseInt(
      process.env.VLLM_VOICE_CHAT_MAX_TOKENS || "1024",
      10
    );
    const thinkingMaxTokens = parseInt(
      process.env.VLLM_VOICE_THINKING_MAX_TOKENS || "8192",
      10
    );

    const model = this.modelForMode(enableThinking);

    const body: any = {
      model,
      messages: [{ role: "system", content: this.systemPrompt }, ...messages],
      max_tokens: enableThinking ? thinkingMaxTokens : standardMaxTokens,
      extra_body: { chat_template_kwargs: { enable_thinking: enableThinking } },
      temperature: parseFloat(process.env.VLLM_TEMPERATURE ?? "0"),
      chat_template_kwargs: { enable_thinking: enableThinking },
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
      id: tc.id,
      name: tc.function?.name || "",
      arguments: (() => {
        try { return JSON.parse(tc.function?.arguments || "{}"); }
        catch { return {}; }
      })(),
    }));

    if (toolCalls.length > 0) {
      logger.info(TAG, `Tool calls via ${model}: ${toolCalls.map(t => t.name).join(", ")}`);
    }
    if (content) {
      logger.info(TAG, `Response via ${model} (${content.length} chars): "${content.substring(0, 80)}..."`);
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
    const maxTokens = parseInt(process.env.VLLM_VOICE_MAX_TOKENS || "0", 10);
    const allMessages: ChatMessage[] = [
      { role: "system", content: this.systemPrompt },
      ...messages,
      { role: "user", content: userMessage },
    ];
    const model = this.modelForMode(false);

    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: allMessages,
        ...(maxTokens > 0 ? { max_tokens: maxTokens } : {}),
        temperature: 0.7,
        stream: true,
        extra_body: { chat_template_kwargs: { enable_thinking: false } },
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
    const softBreak = /[,;:]\s*$/;

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
            } else if (sentenceBuffer.trim().length > 55) {
              const softIndex = Math.max(
                sentenceBuffer.lastIndexOf(","),
                sentenceBuffer.lastIndexOf(";"),
                sentenceBuffer.lastIndexOf(":")
              );
              if (softBreak.test(sentenceBuffer) || softIndex > 55) {
                const splitAt = softIndex > 55 ? softIndex + 1 : sentenceBuffer.length;
                const phrase = sentenceBuffer.slice(0, splitAt).trim();
                sentenceBuffer = sentenceBuffer.slice(splitAt).trimStart();
                yield phrase;
              }
            }

            if (sentenceBuffer.trim().length > 115) {
              const breakIndex = sentenceBuffer.lastIndexOf(" ");
              if (breakIndex > 80) {
                const phrase = sentenceBuffer.slice(0, breakIndex).trim();
                sentenceBuffer = sentenceBuffer.slice(breakIndex + 1);
                yield phrase;
              }
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
export const VOICE_SYSTEM_PROMPT = `You are Celina in a live voice call with {{CALLER_NAME}}. Your words are spoken aloud.

/no_think
Voice rules:
- Keep normal replies concise and natural: usually 1-4 spoken sentences.
- Use a warmer, longer answer only when {{CALLER_NAME}} asks for depth, a story, planning, debugging, research, or implementation.
- Infer intent through minor speech-to-text errors.
- Do not use markdown, lists, code fences, hidden reasoning, meta commentary, or "as an AI".
- Use tools directly for current facts, system checks, commands, or requested actions; do not announce the tool first.
- After tool results, give the useful outcome in plain spoken language.`;

export function buildVoiceSystemPrompt(callerName: string): string {
  const displayName = callerName.trim() || "the caller";
  return VOICE_SYSTEM_PROMPT.replace(/\{\{CALLER_NAME\}\}/g, displayName);
}
