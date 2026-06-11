/**
 * Rich tool result — text plus optional JPEG frames that the pipeline
 * attaches to the tool message as OpenAI image_url content parts.
 */
export interface VoiceToolRichResult {
  /** Text summary shown to the LLM (and used for logging) */
  text: string;
  /** Optional JPEG images returned alongside the text */
  images?: Buffer[];
}

/**
 * Voice tool definition — tools available during voice calls.
 * Each tool has a JSON schema for the LLM and an execute function.
 */
export interface VoiceTool {
  name: string;
  description: string;
  parameters: Record<string, any>; // JSON Schema
  /** Brief phrase Celina says while this tool runs (TTS filler) */
  fillerPhrase: string;
  /** Execute the tool and return a text (or rich) result for the LLM */
  execute(args: Record<string, any>): Promise<string | VoiceToolRichResult>;
}

/**
 * Tool call parsed from LLM response
 */
export interface ToolCall {
  id?: string;
  name: string;
  arguments: Record<string, any>;
}

/**
 * Convert VoiceTool[] to the OpenAI tools format for the API
 */
export function toOpenAITools(tools: VoiceTool[]): any[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: "object",
        properties: t.parameters,
        required: Object.keys(t.parameters),
      },
    },
  }));
}
