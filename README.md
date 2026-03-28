# matrix-voip-agent

Headless Matrix WebRTC voice call agent that auto-answers Matrix VoIP calls and bridges audio through a PipeWire pipeline to an AI agent's TTS/STT stack.

Built for [OpenClaw](https://github.com/openclaw) but adaptable to any system that can produce/consume audio via PipeWire virtual devices.

## Architecture

```
Caller (Element) ──Matrix VoIP──> matrix-voip-agent ──PipeWire──> AI Agent
                                       │                              │
                                       │  WebRTC (werift)             │  STT (e.g. Whisper)
                                       │  Opus ↔ PCM                  │  LLM (any provider)
                                       │  ICE/TURN                    │  TTS (e.g. ElevenLabs)
                                       │                              │
Caller hears agent <──WebRTC──  <── pw-record <── tts_mic (PipeWire source)
Caller speaks      ──WebRTC──>  ──> pw-play   ──> stt_speaker (PipeWire sink)
```

### Audio flow in detail

```
Caller speaks into Matrix client
       │
       ▼
[WebRTC audio stream]
       │
       ▼ Opus decode
[matrix-voip-agent]
       │
       ▼ pw-play
[stt_speaker]           ← PipeWire sink (configurable)
       │
       ▼ PipeWire loopback
[stt_capture]           ← PipeWire source
       │
       ▼
[STT engine]  →  text  →  [AI agent]
                                │
                                ▼
                      Agent generates response
                                │
                                ▼
                      [TTS engine]  →  audio
                                │
                                ▼
                      [tts_sink]           ← PipeWire sink
                                │
                                ▼ PipeWire loopback
                      [tts_mic]            ← PipeWire source (configurable)
                                │
                                ▼ pw-record
                      [matrix-voip-agent]
                                │
                                ▼ Opus encode
                      [WebRTC audio stream]
                                │
                                ▼
                      Caller hears the agent
```

## Prerequisites

- **Node.js** >= 20
- **PipeWire** with two loopback virtual devices configured (see [PipeWire Setup](#pipewire-setup))
- **pw-play** and **pw-record** available in PATH
- **libopus-dev** installed (`sudo apt install libopus-dev`)
- A **Matrix homeserver** (e.g. Dendrite, Synapse) with TURN server configured
- An AI agent with TTS and STT that reads/writes audio via PipeWire

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/AEON-7/matrix-voip-agent.git
cd matrix-voip-agent
npm install

# 2. Configure
cp .env.example .env
# Edit .env — set MATRIX_ACCESS_TOKEN, MATRIX_USER_ID, and AUTHORIZED_USERS

# 3. Build and run
npm run build
npm start
```

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

| Variable | Required | Default | Description |
|---|---|---|---|
| `MATRIX_HOMESERVER_URL` | No | `http://127.0.0.1:8008` | Matrix homeserver URL |
| `MATRIX_USER_ID` | **Yes** | — | Bot's full Matrix user ID (e.g. `@bot:example.com`) |
| `MATRIX_ACCESS_TOKEN` | **Yes** | — | Access token from the login step above |
| `MATRIX_DEVICE_NAME` | No | `OpenClaw Voice` | Device name shown in Matrix sessions |
| `AUTHORIZED_USERS` | **Yes** | — | Comma-separated Matrix user IDs allowed to call |
| `PIPEWIRE_STT_SINK` | No | `input.openclaw_stt_speaker` | PipeWire sink name for incoming caller audio |
| `PIPEWIRE_TTS_SOURCE` | No | `openclaw_tts_mic` | PipeWire source name for outgoing agent audio |
| `MAX_CONCURRENT_CALLS` | No | `1` | Maximum simultaneous calls |
| `CALL_TIMEOUT_MS` | No | `1800000` | Auto-hangup timeout in ms (default: 30 min) |
| `CRYPTO_STORE_PATH` | No | `./crypto-store` | Path for Matrix E2EE key storage |
| `LOG_LEVEL` | No | `info` | Log level: `debug`, `info`, `warn`, `error` |

## PipeWire Setup

Two PipeWire loopback devices bridge audio between WebRTC and your AI agent.

### TTS loopback (agent voice → caller)

Create `~/.config/pipewire/pipewire.conf.d/voip-tts-sink.conf`:

```
context.modules = [
    {
        name = libpipewire-module-loopback
        args = {
            node.name = "voip_tts"
            node.description = "VoIP Agent TTS"
            capture.props = {
                media.class = "Audio/Sink"
                audio.position = [ FL FR ]
            }
            playback.props = {
                media.class = "Audio/Source"
                node.name = "voip_tts_mic"
                node.description = "VoIP Agent TTS Microphone"
                audio.position = [ MONO ]
            }
        }
    }
]
```

### STT loopback (caller voice → agent)

Create `~/.config/pipewire/pipewire.conf.d/voip-stt-source.conf`:

```
context.modules = [
    {
        name = libpipewire-module-loopback
        args = {
            node.name = "voip_stt_speaker"
            node.description = "VoIP Agent STT Speaker"
            capture.props = {
                media.class = "Audio/Sink"
                audio.position = [ FL FR ]
            }
            playback.props = {
                media.class = "Audio/Source"
                node.name = "voip_stt_capture"
                node.description = "VoIP Agent STT Capture"
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
pactl list sinks short | grep voip
pactl list sources short | grep voip
```

Update `PIPEWIRE_STT_SINK` and `PIPEWIRE_TTS_SOURCE` in your `.env` to match the `node.name` values you chose.

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

The service file uses systemd specifiers (`%h` for home directory, `%U` for UID) so it works for any user without modification.

## How a Call Works

1. A Matrix user taps **Call** on the bot's profile in Element (or any Matrix client)
2. Element sends an `m.call.invite` event with an SDP offer
3. `matrix-voip-agent` receives the event and checks if the caller is in `AUTHORIZED_USERS`
4. If unauthorized → automatic `user_busy` rejection
5. If authorized → creates a WebRTC peer connection using TURN credentials from the homeserver
6. Sends `m.call.answer` with an SDP answer
7. ICE candidates are exchanged, DTLS/SRTP is established
8. Audio flows bidirectionally through PipeWire (see architecture diagram above)
9. Either side can hang up (`m.call.hangup`), or the call auto-ends after `CALL_TIMEOUT_MS`

## TURN Server

The agent fetches TURN credentials from your Matrix homeserver's `/voip/turnServer` endpoint. Your homeserver must have a TURN server (e.g. coturn) configured for WebRTC NAT traversal to work.

Test TURN availability:

```bash
curl -s http://127.0.0.1:8008/_matrix/client/v3/voip/turnServer \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" | python3 -m json.tool
```

Expected: JSON with `username`, `password`, `uris`, and `ttl`.

## License

MIT
