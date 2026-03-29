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
  /** Execute the tool and return a text result for the LLM */
  execute(args: Record<string, any>): Promise<string>;
}

/**
 * Tool call parsed from LLM response
 */
export interface ToolCall {
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
