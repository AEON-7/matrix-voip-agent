# matrix-voip-agent

Headless Matrix WebRTC voice call agent. Auto-answers (and initiates) Matrix VoIP calls with real-time voice conversation powered by local STT, direct LLM inference, and cloud TTS.

Call your AI agent from any Matrix client. The agent hears you, thinks, and talks back — all in ~4 seconds.

---

## Choose Your Installation Path

### Path A: I already have a Matrix server

You have a working Matrix homeserver (Dendrite, Synapse, Conduit) with a TURN server configured. You just want to add voice agent capabilities.

```bash
git clone https://github.com/AEON-7/matrix-voip-agent.git
cd matrix-voip-agent
bash setup.sh
```

The setup script installs all voice agent dependencies (whisper.cpp, PipeWire, Node.js) and walks you through connecting to your existing Matrix server. **[Jump to Path A details](#path-a-add-voice-agent-to-existing-matrix-server)**

### Path B: I want the full turnkey setup

You don't have a Matrix server yet. This path sets up **everything from scratch** — a fully federated Matrix homeserver with encrypted messaging, TURN server for voice/video, automatic TLS certificates, dynamic DNS, and the AI voice agent — all on a single machine.

```bash
git clone https://github.com/AEON-7/matrix-voip-agent.git
cd matrix-voip-agent
bash setup-homeserver.sh
bash setup.sh
```

Two scripts, fully automated. When they finish, you have a production Matrix server with an AI agent you can call. **[Jump to Path B details](#path-b-turnkey-matrix-server--voice-agent)**

---

## Path A: Add Voice Agent to Existing Matrix Server

### What you need

- A running Matrix homeserver (Dendrite, Synapse, or Conduit) accessible at an HTTP URL
- A TURN server (coturn) configured on the homeserver for WebRTC NAT traversal
- A bot account on the homeserver with a password or access token
- A Linux machine to run the voice agent (can be the same machine as the homeserver)

### Install

```bash
git clone https://github.com/AEON-7/matrix-voip-agent.git
cd matrix-voip-agent
bash setup.sh
```

The setup script:
1. Installs system packages (PipeWire, ffmpeg, cmake, libopus)
2. Installs Node.js 22 if needed
3. Creates PipeWire virtual audio devices for the voice pipeline
4. Builds whisper.cpp and downloads the speech recognition model
5. Installs Node.js dependencies and compiles TypeScript
6. Walks you through entering your credentials:
   - Matrix homeserver URL, bot user ID, access token
   - LLM server URL, API key, and model name
   - ElevenLabs API key and voice ID

When it finishes, start the agent:

```bash
npm start
```

> **Fully unattended install** (no prompts, requires .env pre-configured): `bash setup.sh --auto`

### TURN server requirement

Your Matrix homeserver **must** have a TURN server configured. Without it, WebRTC calls will only work on the same LAN. The voice agent fetches TURN credentials automatically from the homeserver.

**Important:** The TURN URI must point to the actual server IP, not a domain behind a CDN like Cloudflare (Cloudflare doesn't proxy UDP/TURN traffic).

Verify your TURN setup:
```bash
curl -s http://YOUR_HOMESERVER/_matrix/client/v3/voip/turnServer \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" | python3 -m json.tool
```

You should see `username`, `password`, `uris` (with TURN server addresses), and `ttl`.

---

## Path B: Turnkey Matrix Server + Voice Agent

### What you need

- A Linux server (Ubuntu 22.04+ recommended) with a public IP or port forwarding on ports 443 and 3478
- A domain name (purchased, or free via DuckDNS/FreeDNS)
- An email address (for Let's Encrypt TLS certificates)

### What you get

After running two scripts, you'll have:

| Component | What it does |
|---|---|
| **Dendrite** | Matrix homeserver — handles messaging, rooms, E2EE, federation |
| **PostgreSQL** | Database for Dendrite |
| **Caddy** | Reverse proxy with automatic HTTPS via Let's Encrypt |
| **coturn** | TURN/STUN server for WebRTC NAT traversal |
| **DynDNS updater** | Keeps your domain pointed at your IP (DuckDNS, No-IP, or custom) |
| **matrix-voip-agent** | AI voice agent with STT, LLM, and TTS |

All running as Docker containers (except the voice agent, which needs PipeWire access).

### Install

```bash
git clone https://github.com/AEON-7/matrix-voip-agent.git
cd matrix-voip-agent
bash setup-homeserver.sh
bash setup.sh
```

#### Step 1: `setup-homeserver.sh`

This script sets up the full Matrix server infrastructure:

1. **Docker** — installs Docker and Docker Compose if missing
2. **Dynamic DNS** — configures automatic DNS updates:
   - DuckDNS (free, recommended)
   - No-IP
   - FreeDNS (afraid.org)
   - Custom/manual (bring your own domain)
3. **TLS certificates** — obtains Let's Encrypt certificates via Caddy's automatic ACME
4. **Dendrite** — deploys the Matrix homeserver with PostgreSQL in Docker
5. **coturn** — deploys the TURN server for WebRTC voice/video calls
6. **Federation** — configures `.well-known` endpoints so other Matrix servers can find yours
7. **Accounts** — creates the bot account and an admin account
8. **Firewall** — opens required ports (443 HTTPS, 3478 TURN, 8448 federation)

The script asks for:
- Your domain (or helps you set up DuckDNS for free)
- Email for Let's Encrypt
- Admin and bot account passwords

When it finishes, you have a fully working federated Matrix server accessible at `https://your-domain.duckdns.org`.

#### Step 2: `setup.sh`

This installs the voice agent and connects it to the homeserver that `setup-homeserver.sh` just created. It detects the local homeserver automatically.

#### Step 3: Test

1. Install Element on your phone or desktop
2. Sign in at `https://your-domain.duckdns.org` with the admin account
3. Start a DM with the bot account
4. Tap the phone icon to call
5. Talk — the agent responds in ~4 seconds

### Dynamic DNS providers

The homeserver setup supports these providers out of the box:

| Provider | Cost | Setup | Notes |
|---|---|---|---|
| **DuckDNS** | Free | Create account at duckdns.org, get token | Recommended for simplicity |
| **No-IP** | Free (with renewal) | Create account at noip.com | Requires monthly renewal on free tier |
| **FreeDNS** | Free | Create account at freedns.afraid.org | Many domain options |
| **Custom domain** | Varies | Point A record to your IP | Full control, requires DNS provider |

For custom domains, you manage DNS yourself. The script still handles TLS certificates via Let's Encrypt.

### Ports

The homeserver needs these ports open (the setup script configures `ufw` if available):

| Port | Protocol | Service | Required? |
|---|---|---|---|
| 443 | TCP | HTTPS (Caddy) | Yes |
| 8448 | TCP | Matrix federation | Yes for federation |
| 3478 | TCP + UDP | TURN/STUN (coturn) | Yes for voice/video calls |
| 5349 | TCP | TURNS (TLS) | Optional, for TURN over TLS |
| 49152-65535 | UDP | TURN relay range | Yes for voice/video calls |

### Architecture (turnkey deployment)

```
Internet
    │
    ├── :443 ──> Caddy (TLS termination, reverse proxy)
    │               ├── /_matrix/* ──> Dendrite (Matrix homeserver)
    │               ├── /.well-known/* ──> Federation endpoints
    │               └── /voice/* ──> Voice agent webhook (if using Twilio)
    │
    ├── :3478 ──> coturn (TURN/STUN server)
    │
    └── :8448 ──> Caddy ──> Dendrite (federation)

Local only:
    :8008 ──> Dendrite (client API, localhost)
    :8178 ──> whisper-server (STT, per-call)
    :8179 ──> Voice agent API (outbound calls)
    :18789 ──> OpenClaw gateway (optional)

DynDNS cron:
    Every 5 min ──> updates DNS provider with current public IP
```

---

## Architecture (Voice Agent)

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
| `check_server_status` | "Is the server running?" | "Checking the server now." |
| `run_command` | "How much disk space is left?" | "Running that command now." |
| `web_search` | "What's the weather?" | "Let me search for that." |
| `send_message` | "Post that in the chat" | "Sending that message now." |

## Outbound Calls

The agent can initiate calls to Matrix users via the HTTP API:

```bash
curl -X POST http://127.0.0.1:8179/call \
  -H "Authorization: Bearer YOUR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "roomId": "!your-room-id:homeserver",
    "userId": "@target-user:homeserver",
    "greeting": "Hey, just calling to check in."
  }'
```

| Method | Path | Body | Description |
|---|---|---|---|
| `POST` | `/call` | `{roomId, userId, greeting?}` | Initiate outbound call |
| `POST` | `/hangup` | `{callId}` | End an active call |
| `GET` | `/status` | — | Get active call count |

## Configuration Reference

All configuration is via environment variables (loaded from `.env`). Run `bash setup.sh` to configure interactively, or edit `.env` directly.

<details>
<summary>Click to expand full configuration reference</summary>

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
| `VLLM_BASE_URL` | **Yes** | — | OpenAI-compatible API endpoint |
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

### ElevenLabs (TTS)

| Variable | Required | Default | Description |
|---|---|---|---|
| `ELEVENLABS_API_KEY` | **Yes** | — | ElevenLabs API key |
| `ELEVENLABS_VOICE_ID` | **Yes** | — | Voice ID for TTS |
| `ELEVENLABS_MODEL` | No | `eleven_flash_v2_5` | TTS model |

### OpenAI (fallback STT)

| Variable | Default | Description |
|---|---|---|
| `OPENAI_API_KEY` | — | Only needed if whisper fails |
| `OPENAI_STT_MODEL` | `gpt-4o-mini-transcribe` | Realtime transcription model |

### Voice tools

| Variable | Default | Description |
|---|---|---|
| `BRAVE_SEARCH_API_KEY` | — | Brave Search API for `web_search` tool |

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

</details>

## Call Transcripts

All voice calls are automatically transcribed and saved on hangup:

- **Markdown**: `~/matrix-voip-agent/transcripts/call-YYYY-MM-DD_HH-MM-SS.md`
- **JSON**: `~/matrix-voip-agent/transcripts/call-YYYY-MM-DD_HH-MM-SS.json`

## Run as a systemd Service

```bash
cp systemd/matrix-voip-agent.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now matrix-voip-agent.service
journalctl --user -u matrix-voip-agent.service -f
```

## Whisper Model Options

| Model | Size | Speed (CPU) | Accuracy | Best for |
|---|---|---|---|---|
| `tiny` | 75 MB | ~0.3s | Basic | Testing only |
| **`base`** | 142 MB | **~1.5s** | Good | **Voice calls (recommended)** |
| `small` | 466 MB | ~4.5s | Better | Higher accuracy needed |
| `medium` | 1.5 GB | ~10s | Great | Non-real-time |
| `large-v3` | 3.1 GB | ~20s | Best | Offline batch |

Download: `cd ~/whisper.cpp && ./models/download-ggml-model.sh base`

## License

MIT
