import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";
import { logger } from "./logger.js";

const TAG = "voice-memory";

export interface VoiceMemoryConfig {
  enabled: boolean;
  paths: string[];
  maxChars: number;
  maxFileChars: number;
}

export function loadVoiceMemoryContext(config: VoiceMemoryConfig): string {
  if (!config.enabled) return "";

  const files = collectMemoryFiles(config.paths);
  const sections: string[] = [];
  let totalChars = 0;

  for (const file of files) {
    if (totalChars >= config.maxChars) break;

    let content: string;
    try {
      content = readFileSync(file, "utf8").trim();
    } catch (err: any) {
      logger.warn(TAG, `Failed to read ${file}: ${err.message}`);
      continue;
    }

    if (!content) continue;

    if (content.length > config.maxFileChars) {
      content = `${content.slice(0, config.maxFileChars).trim()}\n\n[File truncated for voice-call prompt budget.]`;
    }

    const header = `### ${file}`;
    const section = `${header}\n${content}`;
    const remaining = config.maxChars - totalChars;
    const finalSection = section.length > remaining
      ? `${section.slice(0, Math.max(0, remaining - 60)).trim()}\n\n[Memory context truncated.]`
      : section;

    sections.push(finalSection);
    totalChars += finalSection.length + 2;
  }

  if (sections.length === 0) {
    logger.warn(TAG, "No voice memory files loaded");
    return "";
  }

  logger.info(TAG, `Loaded ${sections.length} memory files into voice prompt (${totalChars} chars)`);

  return [
    "Persistent OpenClaw memory context:",
    "Use this as background continuity for the live voice call. Prefer current tool results over old operational facts when they conflict.",
    "Do not recite these files unless asked. Let them quietly inform identity, preferences, projects, infrastructure, and relationship context.",
    "",
    sections.join("\n\n"),
  ].join("\n");
}

function collectMemoryFiles(paths: string[]): string[] {
  const seen = new Set<string>();
  const files: string[] = [];

  for (const rawPath of paths) {
    const path = resolveHome(rawPath);
    if (!existsSync(path)) {
      logger.warn(TAG, `Configured memory path does not exist: ${path}`);
      continue;
    }

    const stat = statSync(path);
    if (stat.isFile() && isMemoryFile(path)) {
      addFile(path, seen, files);
    } else if (stat.isDirectory()) {
      for (const file of collectDir(path, 0, 3)) {
        addFile(file, seen, files);
      }
    }
  }

  return files;
}

function collectDir(dir: string, depth: number, maxDepth: number): string[] {
  if (depth > maxDepth) return [];

  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name));

  const files: string[] = [];
  for (const entry of entries) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectDir(path, depth + 1, maxDepth));
    } else if (entry.isFile() && isMemoryFile(path)) {
      files.push(path);
    }
  }

  return files;
}

function addFile(path: string, seen: Set<string>, files: string[]): void {
  if (seen.has(path)) return;
  seen.add(path);
  files.push(path);
}

function isMemoryFile(path: string): boolean {
  return /\.(md|txt)$/i.test(path);
}

function resolveHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}
