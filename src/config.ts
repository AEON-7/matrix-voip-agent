import { config as loadDotenv } from "dotenv";
import { resolve } from "path";

loadDotenv();

export interface Config {
  matrix: {
    homeserverUrl: string;
    userId: string;
    accessToken: string;
    deviceId: string;
    deviceName: string;
    e2eeEnabled: boolean;
    e2eeRequired: boolean;
    recoveryKeyFile: string;
    cryptoStorePassword: string;
    autoCrossSign: boolean;
    restoreKeyBackupOnStart: boolean;
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
  vllm: {
    baseUrl: string;
    apiKey: string;
    model: string;
    systemPrompt: string;
  };
  omni: {
    enabled: boolean;
    baseUrl: string;
    model: string;
    speaker: string;
    apiKey: string;
  };
  voxtral: {
    enabled: boolean;
    baseUrl: string;
    voice: string;
    model: string;
    voiceDescription: string;
    voiceStyleField: string;
    voiceStyleTemplate: string;
    language: string;
  };
  elevenlabs: {
    apiKey: string;
    voiceId: string;
    model: string;
  };
  calls: {
    maxConcurrent: number;
    timeoutMs: number;
    callerName: string;
  };
  voiceMemory: {
    enabled: boolean;
    paths: string[];
    maxChars: number;
    maxFileChars: number;
  };
  voiceOutput: {
    ttsResponseMode: "chunked" | "full";
  };
  video: {
    /** VIDEO_ENABLED=false — accept + sample inbound video tracks (per-agent .env opt-in; dist/ is shared by all units) */
    enabled: boolean;
    /** VIDEO_FRAME_FPS=1 — ffmpeg fps filter rate; frames above this are dropped before decode */
    frameFps: number;
    /** VIDEO_FRAME_WIDTH=512 — JPEG width, height keeps aspect */
    frameWidth: number;
    /** VIDEO_RING_SIZE=8 — frames kept in the per-call ring buffer */
    ringSize: number;
    /** VIDEO_AUTO_ATTACH=off — "latest" attaches the freshest frame to each user voice turn */
    autoAttach: "off" | "latest";
    /** VIDEO_LOOK_IMAGE_ROLE=tool — where look's image parts ride; "user" if the chat template rejects images in tool messages */
    lookImageRole: "tool" | "user";
  };
  cryptoStorePath: string;
  logLevel: string;
}

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function envBool(key: string, defaultValue: boolean): boolean {
  const val = process.env[key];
  if (val === undefined || val === "") return defaultValue;
  return !["0", "false", "no", "off"].includes(val.toLowerCase());
}

function envChoice<T extends string>(
  key: string,
  choices: readonly T[],
  defaultValue: T
): T {
  const val = process.env[key];
  return choices.includes(val as T) ? (val as T) : defaultValue;
}

export function loadConfig(): Config {
  return {
    matrix: {
      homeserverUrl: process.env.MATRIX_HOMESERVER_URL || "http://127.0.0.1:8008",
      userId: requireEnv("MATRIX_USER_ID"),
      accessToken: requireEnv("MATRIX_ACCESS_TOKEN"),
      deviceId: process.env.MATRIX_DEVICE_ID || "OPENCLAW_VOICE",
      deviceName: process.env.MATRIX_DEVICE_NAME || "OpenClaw Voice",
      e2eeEnabled: envBool("MATRIX_E2EE_ENABLED", true),
      e2eeRequired: envBool("MATRIX_E2EE_REQUIRED", false),
      recoveryKeyFile: resolve(
        process.env.MATRIX_RECOVERY_KEY_FILE || "./secrets/recovery-key.txt"
      ),
      cryptoStorePassword: process.env.MATRIX_CRYPTO_STORE_PASSWORD || "",
      autoCrossSign: envBool("MATRIX_AUTO_CROSS_SIGN", true),
      restoreKeyBackupOnStart: envBool("MATRIX_RESTORE_KEY_BACKUP_ON_START", true),
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
    vllm: {
      baseUrl: process.env.VLLM_BASE_URL || "http://192.168.1.116:8000/v1",
      apiKey: process.env.VLLM_API_KEY || "",
      model: process.env.VLLM_MODEL || "vLLM_txn545_Qwen3.5-122B-A10B-NVFP4",
      systemPrompt: process.env.VLLM_SYSTEM_PROMPT || "",
    },
    omni: {
      enabled: process.env.OMNI_ENABLED === "true",
      baseUrl: process.env.OMNI_BASE_URL || "http://192.168.1.116:9000/v1",
      model: process.env.OMNI_MODEL || "/model",
      speaker: process.env.OMNI_SPEAKER || "chelsie",
      apiKey: process.env.OMNI_API_KEY || "EMPTY",
    },
    voxtral: {
      enabled: process.env.VOXTRAL_ENABLED === "true",
      baseUrl: process.env.VOXTRAL_BASE_URL || "http://192.168.1.116:8091/v1",
      voice: process.env.VOXTRAL_VOICE || "cheerful_female",
      model: process.env.VOXTRAL_MODEL || "Voxtral-4B-TTS-2603-mlx-4bit",
      voiceDescription: process.env.VOXTRAL_VOICE_DESCRIPTION || "",
      voiceStyleField: process.env.VOXTRAL_VOICE_STYLE_FIELD || "instructions",
      voiceStyleTemplate: process.env.VOXTRAL_VOICE_STYLE_TEMPLATE || "",
      language: process.env.VOXTRAL_LANGUAGE || "English",
    },
    elevenlabs: {
      apiKey: process.env.ELEVENLABS_API_KEY || "",
      voiceId: process.env.ELEVENLABS_VOICE_ID || "",
      model: process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5",
    },
    calls: {
      maxConcurrent: parseInt(process.env.MAX_CONCURRENT_CALLS || "1", 10),
      timeoutMs: parseInt(process.env.CALL_TIMEOUT_MS || "1800000", 10),
      callerName: process.env.VOICE_CALLER_NAME || process.env.CALLER_NAME || "caller",
    },
    voiceMemory: {
      enabled: process.env.VOICE_MEMORY_ENABLED !== "false",
      paths: (process.env.VOICE_MEMORY_PATHS || [
        "~/.openclaw/workspace-main/USER.md",
        "~/.openclaw/workspace-main/IDENTITY.md",
        "~/.openclaw/workspace-main/SOUL.md",
        "~/.openclaw/workspace-main/TOOLS.md",
        "~/.openclaw/memory/knowledge/system-config.md",
      ].join(","))
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean),
      maxChars: parseInt(process.env.VOICE_MEMORY_MAX_CHARS || "12000", 10),
      maxFileChars: parseInt(process.env.VOICE_MEMORY_MAX_FILE_CHARS || "2400", 10),
    },
    voiceOutput: {
      ttsResponseMode: envChoice(
        "VOICE_TTS_RESPONSE_MODE",
        ["chunked", "full"] as const,
        "chunked"
      ),
    },
    video: {
      // Default OFF: dist/ may be shared by many per-persona units, so video
      // acceptance is a per-agent .env opt-in (enable on one canary unit first).
      enabled: envBool("VIDEO_ENABLED", false),
      frameFps: parseFloat(process.env.VIDEO_FRAME_FPS || "1") || 1,
      frameWidth: parseInt(process.env.VIDEO_FRAME_WIDTH || "512", 10) || 512,
      ringSize: parseInt(process.env.VIDEO_RING_SIZE || "8", 10) || 8,
      autoAttach: envChoice(
        "VIDEO_AUTO_ATTACH",
        ["off", "latest"] as const,
        "off"
      ),
      lookImageRole: envChoice(
        "VIDEO_LOOK_IMAGE_ROLE",
        ["tool", "user"] as const,
        "tool"
      ),
    },
    cryptoStorePath: resolve(
      process.env.CRYPTO_STORE_PATH || "./crypto-store"
    ),
    logLevel: process.env.LOG_LEVEL || "info",
  };
}
