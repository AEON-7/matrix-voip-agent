import { config as loadDotenv } from "dotenv";
import { resolve } from "path";

loadDotenv();

export interface Config {
  matrix: {
    homeserverUrl: string;
    userId: string;
    accessToken: string;
    deviceName: string;
  };
  authorizedUsers: string[];
  pipewire: {
    sttSink: string;
    ttsSource: string;
  };
  calls: {
    maxConcurrent: number;
    timeoutMs: number;
  };
  cryptoStorePath: string;
  logLevel: string;
}

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

export function loadConfig(): Config {
  return {
    matrix: {
      homeserverUrl: process.env.MATRIX_HOMESERVER_URL || "http://127.0.0.1:8008",
      userId: requireEnv("MATRIX_USER_ID"),
      accessToken: requireEnv("MATRIX_ACCESS_TOKEN"),
      deviceName: process.env.MATRIX_DEVICE_NAME || "OpenClaw Voice",
    },
    authorizedUsers: (process.env.AUTHORIZED_USERS || "")
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean),
    pipewire: {
      sttSink: process.env.PIPEWIRE_STT_SINK || "input.openclaw_stt_speaker",
      ttsSource: process.env.PIPEWIRE_TTS_SOURCE || "openclaw_tts_mic",
    },
    calls: {
      maxConcurrent: parseInt(process.env.MAX_CONCURRENT_CALLS || "1", 10),
      timeoutMs: parseInt(process.env.CALL_TIMEOUT_MS || "1800000", 10),
    },
    cryptoStorePath: resolve(
      process.env.CRYPTO_STORE_PATH || "./crypto-store"
    ),
    logLevel: process.env.LOG_LEVEL || "info",
  };
}
