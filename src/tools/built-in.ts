import { VoiceTool } from "./types.js";
import { logger } from "../logger.js";

const TAG = "tools";

/**
 * Built-in voice tools — lightweight, fast, no external dependencies.
 */

const getCurrentTime: VoiceTool = {
  name: "get_current_time",
  description: "Get the current date and time",
  parameters: {},
  fillerPhrase: "Let me check the time.",
  async execute() {
    const now = new Date();
    const time = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
    const date = now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    return `Current time: ${time}, ${date}`;
  },
};

const checkServerStatus: VoiceTool = {
  name: "check_server_status",
  description: "Check if the vLLM inference server on the DGX Spark is running and healthy",
  parameters: {},
  fillerPhrase: "Checking the server now.",
  async execute() {
    try {
      const resp = await fetch("http://192.168.1.116:8000/health", { signal: AbortSignal.timeout(5000) });
      if (resp.ok) {
        // Also get model info
        const modelsResp = await fetch("http://192.168.1.116:8000/v1/models", {
          headers: { Authorization: `Bearer ${process.env.VLLM_API_KEY || ""}` },
          signal: AbortSignal.timeout(5000),
        });
        if (modelsResp.ok) {
          const models = (await modelsResp.json()) as any;
          const modelList = models.data?.map((m: any) => m.id).join(", ") || "unknown";
          return `DGX Spark vLLM server is healthy. Running models: ${modelList}`;
        }
        return "DGX Spark vLLM server is healthy and responding.";
      }
      return `DGX Spark vLLM server returned status ${resp.status}.`;
    } catch (err: any) {
      return `DGX Spark vLLM server is not reachable: ${err.message}`;
    }
  },
};

const runShellCommand: VoiceTool = {
  name: "run_command",
  description: "Run a simple shell command on the local system and return the output. Use for system checks like disk usage, uptime, process status, etc.",
  parameters: {
    command: { type: "string", description: "The shell command to run (keep it simple and safe)" },
  },
  fillerPhrase: "Running that command now.",
  async execute(args) {
    const { execSync } = await import("child_process");
    const cmd = args.command;

    // Safety: block obviously dangerous commands
    const blocked = ["rm -rf", "mkfs", "dd if=", ":(){ ", "fork bomb", "> /dev/sd", "shutdown", "reboot", "poweroff"];
    if (blocked.some((b) => cmd.toLowerCase().includes(b))) {
      return "I can't run that command — it could damage the system.";
    }

    try {
      const output = execSync(cmd, { timeout: 10000, maxBuffer: 4096 }).toString().trim();
      return output || "(command produced no output)";
    } catch (err: any) {
      return `Command failed: ${err.message.split("\n")[0]}`;
    }
  },
};

const webSearch: VoiceTool = {
  name: "web_search",
  description: "Search the web for current information. Use when asked about news, weather, facts you don't know, or anything that requires up-to-date information.",
  parameters: {
    query: { type: "string", description: "The search query" },
  },
  fillerPhrase: "Let me search for that.",
  async execute(args) {
    const apiKey = process.env.BRAVE_SEARCH_API_KEY || "";
    if (!apiKey) {
      return "Web search is not configured (no BRAVE_SEARCH_API_KEY).";
    }

    try {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(args.query)}&count=3`;
      const resp = await fetch(url, {
        headers: { "X-Subscription-Token": apiKey, Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });

      if (!resp.ok) return `Search failed with status ${resp.status}.`;

      const data = (await resp.json()) as any;
      const results = data.web?.results || [];
      if (results.length === 0) return `No results found for "${args.query}".`;

      return results
        .slice(0, 3)
        .map((r: any, i: number) => `${i + 1}. ${r.title}: ${r.description}`)
        .join("\n");
    } catch (err: any) {
      return `Search error: ${err.message}`;
    }
  },
};

const sendMatrixMessage: VoiceTool = {
  name: "send_message",
  description: "Send a text message in the Matrix chat room. Use when the caller asks you to write or post something in the chat.",
  parameters: {
    message: { type: "string", description: "The message to send" },
  },
  fillerPhrase: "Sending that message now.",
  async execute(args) {
    // This gets special handling in the pipeline — it needs the Matrix client
    return `__SEND_MATRIX__:${args.message}`;
  },
};

/**
 * All built-in voice tools
 */
export const BUILT_IN_TOOLS: VoiceTool[] = [
  getCurrentTime,
  checkServerStatus,
  runShellCommand,
  webSearch,
  sendMatrixMessage,
];

export function getToolByName(name: string): VoiceTool | undefined {
  return BUILT_IN_TOOLS.find((t) => t.name === name);
}
