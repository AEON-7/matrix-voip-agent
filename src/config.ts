import { config as loadDotenv } from "dotenv";
import { resolve } from "path";

loadDotenv();

/**
 * STT backend selector.
 *   "qwen"     — fully offline via aeon-7/qwen3-asr-server (RECOMMENDED, fastest, no cloud)
 *   "whisper"  — local CPU whisper.cpp (no GPU required, slower)
 *   "openai"   — OpenAI Realtime API (cloud, paid)
 */
export type SttBackend = "qwen" | "whisper" | "openai";

/**
 * TTS backend selector.
 *   "qwen"        — fully offline via aeon-7/qwen3-tts-server (RECOMMENDED, no cloud)
 *   "elevenlabs"  — ElevenLabs cloud API (paid)
 */
export type TtsBackend = "qwen" | "elevenlabs";

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
  /** Which STT backend to use. Auto-detects if unset (prefers qwen → whisper → openai). */
  sttBackend: SttBackend | null;
  /** Which TTS backend to use. Auto-detects if unset (prefers qwen → elevenlabs). */
  ttsBackend: TtsBackend | null;
  /** Local Qwen3-ASR sidecar — aeon-7/qwen3-asr-server */
  qwenAsr: {
    endpoint: string;
    model: string;
    language: string;
  };
  /** Local Qwen3-TTS sidecar — aeon-7/qwen3-tts-server */
  qwenTts: {
    endpoint: string;
    model: string;
    voice: string;
    language: string | undefined;
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
  vllm: {
    baseUrl: string;
    apiKey: string;
    model: string;
    systemPrompt: string;
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

function parseBackend<T extends string>(value: string | undefined, allowed: readonly T[]): T | null {
  if (!value) return null;
  const v = value.toLowerCase().trim() as T;
  if ((allowed as readonly string[]).includes(v)) return v;
  throw new Error(`Invalid backend "${value}". Allowed: ${allowed.join(", ")}`);
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
    sttBackend: parseBackend(process.env.STT_BACKEND, ["qwen", "whisper", "openai"] as const) as SttBackend | null,
    ttsBackend: parseBackend(process.env.TTS_BACKEND, ["qwen", "elevenlabs"] as const) as TtsBackend | null,
    qwenAsr: {
      endpoint: process.env.QWEN_ASR_ENDPOINT || process.env.ASR_ENDPOINT || "",
      model: process.env.QWEN_ASR_MODEL || "qwen3-asr",
      language: process.env.QWEN_ASR_LANGUAGE || "auto",
    },
    qwenTts: {
      endpoint: process.env.QWEN_TTS_ENDPOINT || process.env.TTS_ENDPOINT || "",
      model: process.env.QWEN_TTS_MODEL || "qwen3-tts",
      voice: process.env.QWEN_TTS_VOICE
        || "A neutral, friendly adult voice with clear pronunciation, moderate pace, and natural intonation.",
      language: process.env.QWEN_TTS_LANGUAGE || undefined,
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
    vllm: {
      baseUrl: process.env.VLLM_BASE_URL || "http://192.168.1.116:8000/v1",
      apiKey: process.env.VLLM_API_KEY || "",
      model: process.env.VLLM_MODEL || "vLLM_txn545_Qwen3.5-122B-A10B-NVFP4",
      systemPrompt: process.env.VLLM_SYSTEM_PROMPT || "",
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
