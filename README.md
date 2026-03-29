# matrix-voip-agent

Headless Matrix WebRTC voice call agent. Auto-answers (and initiates) Matrix VoIP calls with real-time voice conversation powered by local STT, direct LLM inference, and cloud TTS.

Call your AI agent from any Matrix client. The agent hears you, thinks, and talks back — all in ~4 seconds.

## How to Install and Configure

**Three commands** to get up and running:

```bash
git clone https://github.com/AEON-7/matrix-voip-agent.git
cd matrix-voip-agent
bash setup.sh
```

The setup script installs **all dependencies automatically** — system packages, Node.js, PipeWire virtual audio devices, whisper.cpp speech recognition, and npm modules. It walks you through each step and tells you exactly what it's doing.

When it finishes, edit the `.env` file with your credentials:

```bash
nano .env
```

You'll need to fill in:
- **Matrix bot account** — user ID and access token (the script tells you how to generate one)
- **LLM server** — URL and API key for any OpenAI-compatible endpoint (vLLM, Ollama, OpenAI, etc.)
- **ElevenLabs** — API key and voice ID for text-to-speech
- **Authorized users** — who's allowed to call the bot

Then start:

```bash
npm start
```

Open Element (or any Matrix client), navigate to a DM with the bot, and tap the phone icon. You're live.

> **Fully unattended install** (no prompts): `bash setup.sh --auto`

---

## Requirements

### System

| Requirement | Minimum | Recommended |
|---|---|---|
| **OS** | Linux (PipeWire required) | Ubuntu 24.04+ |
| **Node.js** | 20+ | 22+ |
| **CPU** | 4 cores (for whisper.cpp) | 8+ cores |
| **RAM** | 2 GB (base model) | 4 GB (small model) |
| **Disk** | 500 MB (base model + deps) | 2 GB (small model + deps) |

### Services

| Service | Purpose | Required? |
|---|---|---|
| **Matrix homeserver** | Call signaling (Dendrite, Synapse, Conduit) | Yes |
| **TURN server** | WebRTC NAT traversal (coturn recommended) | Yes for remote calls |
| **PipeWire** | Virtual audio routing between WebRTC and STT/TTS | Yes |
| **LLM server** | AI responses — any OpenAI-compatible API (vLLM, Ollama, OpenAI, etc.) | Yes |
| **ElevenLabs account** | Text-to-speech (free tier works, starter+ recommended) | Yes |

### API Keys and Accounts

| Account | What you need | Free tier? |
|---|---|---|
| **Matrix account** | Bot user account + access token on your homeserver | Self-hosted = free |
| **LLM provider** | OpenAI-compatible endpoint + API key | Local vLLM/Ollama = free |
| **ElevenLabs** | API key + voice ID | Yes (limited characters/month) |
| **OpenAI** *(optional)* | API key for fallback STT | No |
| **Brave Search** *(optional)* | API key for web search tool | Yes (2000 queries/month) |

### System Packages

Install these before starting:

```bash
# Ubuntu/Debian
sudo apt install -y \
  build-essential cmake git curl \
  pipewire pipewire-pulse wireplumber \
  pipewire-audio-client-libraries \
  ffmpeg \
  libopus-dev

# Verify PipeWire is running
pactl info | grep "Server Name"
# Should show: PipeWire
```

### Software to Build

| Software | Purpose | Build instructions |
|---|---|---|
| **whisper.cpp** | Local speech-to-text | See [Whisper Setup](#whisper-setup) below |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    matrix-voip-agent                         │
│                                                             │
│  ┌──────────┐   ┌──────────┐   ┌───────┐   ┌───────────┐  │
│  │ WebRTC   │──>│ PipeWire │──>│Whisper│──>│  LLM API  │  │
│  │ (werift) │   │ loopback │   │  STT  │   │  (vLLM)   │  │
│  │          │<──│          │<──│       │<──│           │  │
│  │ Opus↔PCM │   │ sink/src │   │local  │   │ direct    │  │
│  └──────────┘   └──────────┘   └───────┘   └─────┬─────┘  │
│       ↑                                          │        │
│       │              ┌──────────┐                │        │
│  ┌────┴────┐         │ElevenLabs│<───────────────┘        │
│  │ Matrix  │         │   TTS    │                          │
│  │signaling│         │  (cloud) │                          │
│  │m.call.* │         └──────────┘                          │
│  └─────────┘                                               │
└─────────────────────────────────────────────────────────────┘
         ↕
    Matrix homeserver
    (Dendrite/Synapse)
         ↕
    Element / any Matrix client
```

### Voice conversation flow

```
You speak into Element (~2 seconds of speech)
       │
       ▼ WebRTC audio stream
[matrix-voip-agent] Opus decode → PipeWire
       │
       ▼ pw-record (16kHz PCM)
[whisper.cpp] local STT, ~1.5s (base model)
       │
       ▼ transcript text
[vLLM / LLM API] direct HTTP, thinking OFF, ~1.7s
       │
       ▼ response text (streamed per sentence)
[ElevenLabs TTS] per sentence, ~0.4s
       │
       ▼ PCM audio
[PipeWire] → Opus encode → WebRTC
       │
       ▼
You hear the agent respond (~4s after you stop speaking)
```

### Voice tools

The agent can use tools during voice calls. When a tool is needed, the agent speaks a brief filler phrase while the tool executes in the background.

| Tool | Trigger example | Filler phrase |
|---|---|---|
| `get_current_time` | "What time is it?" | "Let me check the time." |
| `check_server_status` | "Is the DGX running?" | "Checking the server now." |
| `run_command` | "How much disk space is left?" | "Running that command now." |
| `web_search` | "What's the weather?" | "Let me search for that." |
| `send_message` | "Post that in the chat" | "Sending that message now." |

## Quick Start

### 1. Install system dependencies

```bash
sudo apt install -y build-essential cmake git curl ffmpeg libopus-dev \
  pipewire pipewire-pulse wireplumber pipewire-audio-client-libraries
```

### 2. Build whisper.cpp

```bash
git clone https://github.com/ggerganov/whisper.cpp.git ~/whisper.cpp
cd ~/whisper.cpp
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j$(nproc)
./models/download-ggml-model.sh base    # fast, good for voice
# Or: ./models/download-ggml-model.sh small  # slower, more accurate
```

### 3. Set up PipeWire virtual audio devices

Create two loopback configs:

**TTS loopback** (`~/.config/pipewire/pipewire.conf.d/voip-tts-sink.conf`):
```
context.modules = [
    {
        name = libpipewire-module-loopback
        args = {
            node.name = "openclaw_tts"
            node.description = "VoIP Agent TTS"
            capture.props = {
                media.class = "Audio/Sink"
                audio.position = [ FL FR ]
            }
            playback.props = {
                media.class = "Audio/Source"
                node.name = "openclaw_tts_mic"
                node.description = "VoIP Agent TTS Microphone"
                audio.position = [ MONO ]
            }
        }
    }
]
```

**STT loopback** (`~/.config/pipewire/pipewire.conf.d/voip-stt-source.conf`):
```
context.modules = [
    {
        name = libpipewire-module-loopback
        args = {
            node.name = "openclaw_stt_speaker"
            node.description = "VoIP Agent STT Speaker"
            capture.props = {
                media.class = "Audio/Sink"
                audio.position = [ FL FR ]
            }
            playback.props = {
                media.class = "Audio/Source"
                node.name = "openclaw_stt_capture"
                node.description = "VoIP Agent STT Capture"
                audio.position = [ MONO ]
            }
        }
    }
]
```

Then restart PipeWire:
```bash
systemctl --user restart pipewire.service pipewire-pulse.service
pactl list sinks short | grep openclaw   # should show 2 sinks
pactl list sources short | grep openclaw # should show 2 sources
```

### 4. Clone, install, configure

```bash
git clone https://github.com/AEON-7/matrix-voip-agent.git
cd matrix-voip-agent
npm install
cp .env.example .env
```

Edit `.env` and fill in:
- `MATRIX_USER_ID` and `MATRIX_ACCESS_TOKEN` (see [Generate a Matrix Access Token](#generate-a-matrix-access-token))
- `AUTHORIZED_USERS` (who can call the bot)
- `VLLM_BASE_URL`, `VLLM_API_KEY`, `VLLM_MODEL` (your LLM endpoint)
- `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID`

### 5. Build and run

```bash
npm run build
npm start
```

You should see:
```
[INFO] [main] Matrix VoIP Agent ready — waiting for calls
[INFO] [main] API server listening on http://127.0.0.1:8179
```

### 6. Test

Open Element, navigate to a DM with the bot, and tap the phone icon to call.

## Generate a Matrix Access Token

```bash
curl -s -X POST https://YOUR_HOMESERVER/_matrix/client/v3/login \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "m.login.password",
    "identifier": {"type": "m.id.user", "user": "YOUR_BOT_USERNAME"},
    "password": "YOUR_PASSWORD",
    "device_id": "VOIP_AGENT",
    "initial_device_display_name": "VoIP Agent"
  }' | python3 -m json.tool
```

Copy the `access_token` from the response into your `.env` file.

## Whisper Setup

### Model options

| Model | Size | Speed (CPU) | Accuracy | Best for |
|---|---|---|---|---|
| `tiny` | 75 MB | ~0.3s | Basic | Testing only |
| **`base`** | 142 MB | **~1.5s** | Good | **Voice calls (recommended)** |
| `small` | 466 MB | ~4.5s | Better | Higher accuracy needed |
| `medium` | 1.5 GB | ~10s | Great | Non-real-time transcription |
| `large-v3` | 3.1 GB | ~20s | Best | Offline batch processing |

Download models:
```bash
cd ~/whisper.cpp
./models/download-ggml-model.sh base   # recommended for voice calls
```

The agent auto-starts whisper-server when a call connects. To test manually:
```bash
~/whisper.cpp/build/bin/whisper-server \
  -m ~/whisper.cpp/models/ggml-base.bin \
  --language auto --host 127.0.0.1 --port 8178 --convert -t 8
```

## Configuration

All configuration is via environment variables (loaded from `.env`):

### Matrix (call signaling)

| Variable | Required | Default | Description |
|---|---|---|---|
| `MATRIX_HOMESERVER_URL` | No | `http://127.0.0.1:8008` | Matrix homeserver URL |
| `MATRIX_USER_ID` | **Yes** | — | Bot's full Matrix user ID |
| `MATRIX_ACCESS_TOKEN` | **Yes** | — | Access token for the bot account |
| `MATRIX_DEVICE_NAME` | No | `OpenClaw Voice` | Device name in Matrix sessions |
| `AUTHORIZED_USERS` | **Yes** | — | Comma-separated Matrix user IDs allowed to call |

### LLM (direct inference)

| Variable | Required | Default | Description |
|---|---|---|---|
| `VLLM_BASE_URL` | **Yes** | `http://192.168.1.116:8000/v1` | OpenAI-compatible API endpoint |
| `VLLM_API_KEY` | **Yes** | — | API key for the LLM server |
| `VLLM_MODEL` | **Yes** | — | Model name as served by the LLM server |
| `VLLM_SYSTEM_PROMPT` | No | *(built-in)* | Custom system prompt for voice conversations |

### Whisper.cpp (local STT)

| Variable | Default | Description |
|---|---|---|
| `WHISPER_ENABLED` | `true` | Enable local whisper.cpp |
| `WHISPER_LANGUAGE` | `auto` | Language code or `auto` for detection |
| `WHISPER_MODEL_PATH` | `~/whisper.cpp/models/ggml-small.bin` | Path to GGML model file |
| `WHISPER_SERVER_BIN` | `~/whisper.cpp/build/bin/whisper-server` | Path to server binary |
| `WHISPER_SERVER_PORT` | `8178` | HTTP port for whisper-server |
| `WHISPER_AUTO_START` | `true` | Auto-start server on call connect |

### ElevenLabs (TTS)

| Variable | Required | Default | Description |
|---|---|---|---|
| `ELEVENLABS_API_KEY` | **Yes** | — | ElevenLabs API key |
| `ELEVENLABS_VOICE_ID` | **Yes** | — | Voice ID for TTS |
| `ELEVENLABS_MODEL` | No | `eleven_flash_v2_5` | TTS model (flash = low latency) |

### OpenAI (fallback STT)

| Variable | Default | Description |
|---|---|---|
| `OPENAI_API_KEY` | — | Only needed if whisper fails to start |
| `OPENAI_STT_MODEL` | `gpt-4o-mini-transcribe` | Realtime transcription model |

### Voice tools

| Variable | Default | Description |
|---|---|---|
| `BRAVE_SEARCH_API_KEY` | — | Brave Search API key for `web_search` tool |

### PipeWire

| Variable | Default | Description |
|---|---|---|
| `PIPEWIRE_STT_SINK` | `input.openclaw_stt_speaker` | Sink for incoming caller audio |
| `PIPEWIRE_TTS_SOURCE` | `openclaw_tts_mic` | Source for outgoing agent audio |
| `PIPEWIRE_STT_CAPTURE` | `openclaw_stt_capture` | Source for whisper STT capture |
| `PIPEWIRE_TTS_SINK` | `input.openclaw_tts` | Sink for ElevenLabs TTS output |

### Call limits and API

| Variable | Default | Description |
|---|---|---|
| `MAX_CONCURRENT_CALLS` | `1` | Max simultaneous calls |
| `CALL_TIMEOUT_MS` | `1800000` | Auto-hangup after 30 min |
| `API_PORT` | `8179` | HTTP API port for outbound calls |
| `API_TOKEN` | — | Bearer token for the HTTP API |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

## Outbound Calls

The agent can initiate calls to Matrix users via the HTTP API:

```bash
curl -X POST http://127.0.0.1:8179/call \
  -H "Authorization: Bearer YOUR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "roomId": "!your-room-id:homeserver",
    "userId": "@target-user:homeserver",
    "greeting": "Hey, just calling to check in. How are you?"
  }'
```

The target user's Matrix client (Element) will ring. When they answer, the agent speaks the greeting and the voice conversation begins.

### API endpoints

| Method | Path | Body | Description |
|---|---|---|---|
| `POST` | `/call` | `{roomId, userId, greeting?}` | Initiate outbound call |
| `POST` | `/hangup` | `{callId}` | End an active call |
| `GET` | `/status` | — | Get active call count |

## Run as a systemd Service

```bash
cp systemd/matrix-voip-agent.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now matrix-voip-agent.service

# Check status
systemctl --user status matrix-voip-agent.service

# View logs
journalctl --user -u matrix-voip-agent.service -f
```

## Call Transcripts

All voice calls are automatically transcribed and saved on hangup:

- **Markdown**: `~/matrix-voip-agent/transcripts/call-YYYY-MM-DD_HH-MM-SS.md`
- **JSON**: `~/matrix-voip-agent/transcripts/call-YYYY-MM-DD_HH-MM-SS.json`

Each transcript includes timestamps, speaker labels, and the full conversation.

## TURN Server

WebRTC requires a TURN server for calls that cross NAT boundaries. Your Matrix homeserver must have TURN configured (e.g., coturn).

The agent fetches TURN credentials automatically from `/_matrix/client/v3/voip/turnServer`.

**Important:** TURN URIs must point to the actual TURN server IP, not a domain behind Cloudflare (Cloudflare doesn't proxy UDP/TURN traffic).

Test:
```bash
curl -s http://127.0.0.1:8008/_matrix/client/v3/voip/turnServer \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" | python3 -m json.tool
```

## How It Works

### Inbound call (someone calls the agent)

1. Caller taps **Call** in Element
2. Element sends `m.call.invite` with SDP offer
3. Agent checks `AUTHORIZED_USERS` → rejects unauthorized callers
4. Creates WebRTC peer connection with TURN credentials
5. Sends `m.call.answer` with SDP answer
6. ICE candidates exchanged, DTLS/SRTP established
7. Audio bridge starts: WebRTC ↔ PipeWire (Opus codec)
8. Voice pipeline starts: whisper STT → LLM → TTS
9. Conversation flows until hangup or timeout

### Outbound call (agent calls someone)

1. HTTP API receives `POST /call` with room ID and target user
2. Agent creates SDP offer and sends `m.call.invite`
3. Target user's Element client rings
4. When answered, agent receives `m.call.answer`
5. WebRTC connects, voice pipeline starts
6. Agent speaks greeting via TTS
7. Conversation flows until hangup or timeout

## License

MIT
