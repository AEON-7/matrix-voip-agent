# matrix-voip-agent

Headless Matrix WebRTC voice call agent with integrated STT/TTS. Auto-answers Matrix VoIP calls, transcribes the caller's speech locally via whisper.cpp, sends transcripts to the AI agent via Matrix, and speaks the agent's responses back using ElevenLabs TTS.

Built for [OpenClaw](https://github.com/openclaw) (Celina) but adaptable to any Matrix-based AI agent.

## Architecture

```
Caller (Element) ──Matrix VoIP──> matrix-voip-agent ──> Whisper STT (local)
                                       │                       │
                                       │  WebRTC (werift)      │  transcript → Matrix message
                                       │  Opus ↔ PCM           │
                                       │  ICE/TURN             │  AI agent responds (text)
                                       │                       │
Caller hears agent <──WebRTC──  <── PipeWire <── ElevenLabs TTS <── agent response
Caller speaks      ──WebRTC──>  ──> PipeWire ──> whisper.cpp ──> transcript ──> Matrix
```

### Audio flow in detail

```
Albert speaks into Element
       │
       ▼
[WebRTC audio stream]
       │
       ▼ Opus decode
[matrix-voip-agent / audio-bridge]
       │
       ▼ pw-play (writes raw PCM)
[openclaw_stt_speaker]  ← PipeWire sink
       │
       ▼ PipeWire loopback
[openclaw_stt_capture]  ← PipeWire source
       │
       ▼ pw-record (16kHz PCM)
[voice-pipeline / whisper.cpp STT]
       │
       ▼ transcript text
[Matrix room message]  →  AI agent (Celina) sees it
                                 │
                                 ▼
                       Agent generates text response
                                 │
                                 ▼
                       [voice-pipeline / ElevenLabs TTS]  →  PCM audio
                                 │
                                 ▼ pw-play (writes PCM)
                       [openclaw_tts]  ← PipeWire sink
                                 │
                                 ▼ PipeWire loopback
                       [openclaw_tts_mic]  ← PipeWire source
                                 │
                                 ▼ pw-record
                       [matrix-voip-agent / audio-bridge]
                                 │
                                 ▼ Opus encode
                       [WebRTC audio stream]
                                 │
                                 ▼
                       Albert hears Celina in Element
```

### STT priority

1. **whisper.cpp** (local, primary) — 99 languages, auto-detect, zero API cost, ~500ms latency
2. **OpenAI Realtime** (fallback) — used automatically if whisper.cpp fails to start

## Prerequisites

- **Node.js** >= 20
- **PipeWire** with two loopback virtual devices configured (see [PipeWire Setup](#pipewire-setup))
- **pw-play** and **pw-record** available in PATH
- **libopus-dev** installed (`sudo apt install libopus-dev`)
- **whisper.cpp** built with a model downloaded (see [Whisper Setup](#whisper-setup))
- **ElevenLabs API key** and voice ID for TTS
- A **Matrix homeserver** (e.g. Dendrite, Synapse) with TURN server configured
- (Optional) **OpenAI API key** for fallback STT

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/AEON-7/matrix-voip-agent.git
cd matrix-voip-agent
npm install

# 2. Configure
cp .env.example .env
# Edit .env — set Matrix credentials, ElevenLabs keys, and authorized users

# 3. Build and run
npm run build
npm start
```

## Whisper Setup

Build whisper.cpp and download a model:

```bash
# Clone and build
git clone https://github.com/ggerganov/whisper.cpp.git ~/whisper.cpp
cd ~/whisper.cpp
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j$(nproc)

# Download the small model (good multilingual balance, ~500MB)
./models/download-ggml-model.sh small

# Download Silero VAD model for voice activity detection
curl -L -o models/silero-vad.onnx \
  "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx"
```

The agent auto-starts whisper-server on port 8178 when a call connects. To test manually:

```bash
~/whisper.cpp/build/bin/whisper-server \
  -m ~/whisper.cpp/models/ggml-small.bin \
  --language auto --vad --vad-model ~/whisper.cpp/models/silero-vad.onnx \
  --host 127.0.0.1 --port 8178 --convert -t 4
```

### Model options

| Model | Size | Languages | Speed | Accuracy |
|---|---|---|---|---|
| `tiny` | 75 MB | 99 | Fastest | Basic |
| `base` | 142 MB | 99 | Fast | Good |
| `small` | 466 MB | 99 | Moderate | **Recommended** |
| `medium` | 1.5 GB | 99 | Slower | Great |
| `large-v3` | 3.1 GB | 99 | Slowest | Best |

Download other models: `./models/download-ggml-model.sh <model_name>`

## Generate a Matrix Access Token

The agent needs an access token for the bot's Matrix account:

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

## Configuration

All configuration is via environment variables (loaded from `.env`):

### Matrix

| Variable | Required | Default | Description |
|---|---|---|---|
| `MATRIX_HOMESERVER_URL` | No | `http://127.0.0.1:8008` | Matrix homeserver URL |
| `MATRIX_USER_ID` | **Yes** | — | Bot's full Matrix user ID (e.g. `@bot:example.com`) |
| `MATRIX_ACCESS_TOKEN` | **Yes** | — | Access token from the login step above |
| `MATRIX_DEVICE_NAME` | No | `OpenClaw Voice` | Device name shown in Matrix sessions |
| `AUTHORIZED_USERS` | **Yes** | — | Comma-separated Matrix user IDs allowed to call |

### PipeWire

| Variable | Default | Description |
|---|---|---|
| `PIPEWIRE_STT_SINK` | `input.openclaw_stt_speaker` | Sink for incoming caller audio (WebRTC → PipeWire) |
| `PIPEWIRE_TTS_SOURCE` | `openclaw_tts_mic` | Source for outgoing agent audio (PipeWire → WebRTC) |
| `PIPEWIRE_STT_CAPTURE` | `openclaw_stt_capture` | Source for STT capture (PipeWire → whisper) |
| `PIPEWIRE_TTS_SINK` | `input.openclaw_tts` | Sink for TTS playback (ElevenLabs → PipeWire) |

### Whisper.cpp (local STT — primary)

| Variable | Default | Description |
|---|---|---|
| `WHISPER_ENABLED` | `true` | Enable local whisper.cpp STT |
| `WHISPER_LANGUAGE` | `auto` | Language code or `auto` for auto-detection (99 languages) |
| `WHISPER_SERVER_URL` | `http://127.0.0.1:8178` | whisper-server HTTP endpoint |
| `WHISPER_SERVER_PORT` | `8178` | Port for auto-started whisper-server |
| `WHISPER_SERVER_BIN` | `~/whisper.cpp/build/bin/whisper-server` | Path to whisper-server binary |
| `WHISPER_MODEL_PATH` | `~/whisper.cpp/models/ggml-small.bin` | Path to whisper GGML model |
| `WHISPER_VAD_MODEL_PATH` | `~/whisper.cpp/models/silero-vad.onnx` | Path to Silero VAD model |
| `WHISPER_AUTO_START` | `true` | Auto-start whisper-server on call connect |

### OpenAI (fallback STT)

| Variable | Default | Description |
|---|---|---|
| `OPENAI_API_KEY` | — | OpenAI API key (only needed if whisper fails) |
| `OPENAI_STT_MODEL` | `gpt-4o-transcribe` | OpenAI Realtime transcription model |

### ElevenLabs (TTS)

| Variable | Required | Default | Description |
|---|---|---|---|
| `ELEVENLABS_API_KEY` | **Yes** | — | ElevenLabs API key |
| `ELEVENLABS_VOICE_ID` | **Yes** | — | ElevenLabs voice ID |
| `ELEVENLABS_MODEL` | No | `eleven_flash_v2_5` | TTS model (flash recommended for low latency) |

### Call limits

| Variable | Default | Description |
|---|---|---|
| `MAX_CONCURRENT_CALLS` | `1` | Maximum simultaneous calls |
| `CALL_TIMEOUT_MS` | `1800000` | Auto-hangup timeout in ms (default: 30 min) |
| `CRYPTO_STORE_PATH` | `./crypto-store` | Path for Matrix E2EE key storage |
| `LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error` |

## PipeWire Setup

Two PipeWire loopback devices bridge audio between WebRTC and the voice pipeline.

### TTS loopback (agent voice → caller)

Create `~/.config/pipewire/pipewire.conf.d/openclaw-tts-sink.conf`:

```
context.modules = [
    {
        name = libpipewire-module-loopback
        args = {
            node.name = "openclaw_tts"
            node.description = "OpenClaw TTS"
            capture.props = {
                media.class = "Audio/Sink"
                audio.position = [ FL FR ]
            }
            playback.props = {
                media.class = "Audio/Source"
                node.name = "openclaw_tts_mic"
                node.description = "OpenClaw TTS Microphone"
                audio.position = [ MONO ]
            }
        }
    }
]
```

### STT loopback (caller voice → agent)

Create `~/.config/pipewire/pipewire.conf.d/openclaw-stt-source.conf`:

```
context.modules = [
    {
        name = libpipewire-module-loopback
        args = {
            node.name = "openclaw_stt_speaker"
            node.description = "OpenClaw STT Speaker"
            capture.props = {
                media.class = "Audio/Sink"
                audio.position = [ FL FR ]
            }
            playback.props = {
                media.class = "Audio/Source"
                node.name = "openclaw_stt_capture"
                node.description = "OpenClaw STT Capture"
                audio.position = [ MONO ]
            }
        }
    }
]
```

After creating both files, restart PipeWire:

```bash
systemctl --user restart pipewire.service pipewire-pulse.service
```

Verify the devices exist:

```bash
pactl list sinks short | grep openclaw
pactl list sources short | grep openclaw
```

## Run as a systemd Service

```bash
# Copy the service file
cp systemd/matrix-voip-agent.service ~/.config/systemd/user/

# Enable and start
systemctl --user daemon-reload
systemctl --user enable --now matrix-voip-agent.service

# Check status
systemctl --user status matrix-voip-agent.service

# View logs
journalctl --user -u matrix-voip-agent.service -f
```

## How a Call Works

1. A Matrix user taps **Call** on the bot's profile in Element
2. Element sends an `m.call.invite` event with an SDP offer
3. `matrix-voip-agent` checks if the caller is in `AUTHORIZED_USERS`
4. If unauthorized → automatic "busy" rejection
5. If authorized → creates a WebRTC peer connection using TURN credentials
6. Sends `m.call.answer` with an SDP answer
7. ICE candidates are exchanged, DTLS/SRTP is established
8. Audio bridge starts: WebRTC ↔ PipeWire (Opus codec)
9. Voice pipeline starts: whisper.cpp STT + ElevenLabs TTS
10. Caller's speech → local transcription → Matrix message → agent responds → TTS → caller hears
11. Either side can hang up, or the call auto-ends after `CALL_TIMEOUT_MS`

## TURN Server

The agent fetches TURN credentials from your Matrix homeserver's `/voip/turnServer` endpoint. Your homeserver must have a TURN server (e.g. coturn) configured for WebRTC NAT traversal.

```bash
curl -s http://127.0.0.1:8008/_matrix/client/v3/voip/turnServer \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" | python3 -m json.tool
```

Expected: JSON with `username`, `password`, `uris`, and `ttl`.

## License

MIT
