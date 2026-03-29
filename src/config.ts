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
  bridge: {
    userId: string;
    accessToken: string;
  };
  authorizedUsers: string[];
  pipewire: {
    sttSink: string;
    ttsSource: string;
    sttCapture: string;
    ttsSink: string;
  };
  whisper: {
    enabled: boolean;
    serverUrl: string;
    serverBin: string;
    modelPath: string;
    vadModelPath: string;
    language: string;
    autoStartServer: boolean;
    serverPort: number;
  };
  openai: {
    apiKey: string;
    sttModel: string;
  };
  elevenlabs: {
    apiKey: string;
    voiceId: string;
    model: string;
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
    bridge: {
      userId: process.env.BRIDGE_USER_ID || "",
      accessToken: process.env.BRIDGE_ACCESS_TOKEN || "",
    },
    authorizedUsers: (process.env.AUTHORIZED_USERS || "")
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean),
    pipewire: {
      sttSink: process.env.PIPEWIRE_STT_SINK || "input.openclaw_stt_speaker",
      ttsSource: process.env.PIPEWIRE_TTS_SOURCE || "openclaw_tts_mic",
      sttCapture: process.env.PIPEWIRE_STT_CAPTURE || "openclaw_stt_capture",
      ttsSink: process.env.PIPEWIRE_TTS_SINK || "input.openclaw_tts",
    },
    whisper: {
      enabled: process.env.WHISPER_ENABLED !== "false",
      serverUrl: process.env.WHISPER_SERVER_URL || "http://127.0.0.1:8178",
      serverBin: process.env.WHISPER_SERVER_BIN || resolve(process.env.HOME || "~", "whisper.cpp/build/bin/whisper-server"),
      modelPath: process.env.WHISPER_MODEL_PATH || resolve(process.env.HOME || "~", "whisper.cpp/models/ggml-small.bin"),
      vadModelPath: process.env.WHISPER_VAD_MODEL_PATH || resolve(process.env.HOME || "~", "whisper.cpp/models/silero-vad.onnx"),
      language: process.env.WHISPER_LANGUAGE || "auto",
      autoStartServer: process.env.WHISPER_AUTO_START !== "false",
      serverPort: parseInt(process.env.WHISPER_SERVER_PORT || "8178", 10),
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY || "",
      sttModel: process.env.OPENAI_STT_MODEL || "gpt-4o-transcribe",
    },
    elevenlabs: {
      apiKey: process.env.ELEVENLABS_API_KEY || "",
      voiceId: process.env.ELEVENLABS_VOICE_ID || "",
      model: process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5",
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
