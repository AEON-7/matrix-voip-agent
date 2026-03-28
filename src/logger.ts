const LEVELS: Record<string, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel = 1;

export function setLogLevel(level: string): void {
  currentLevel = LEVELS[level] ?? 1;
}

function log(level: string, tag: string, msg: string, data?: unknown): void {
  if ((LEVELS[level] ?? 1) < currentLevel) return;
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}] [${tag}]`;
  if (data !== undefined) {
    console.log(prefix, msg, typeof data === "string" ? data : JSON.stringify(data, null, 2));
  } else {
    console.log(prefix, msg);
  }
}

export const logger = {
  debug: (tag: string, msg: string, data?: unknown) => log("debug", tag, msg, data),
  info: (tag: string, msg: string, data?: unknown) => log("info", tag, msg, data),
  warn: (tag: string, msg: string, data?: unknown) => log("warn", tag, msg, data),
  error: (tag: string, msg: string, data?: unknown) => log("error", tag, msg, data),
};
