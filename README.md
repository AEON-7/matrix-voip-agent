# matrix-voip-agent


[![☕ Tips](https://img.shields.io/badge/%E2%98%95_Tips-Support_the_work-ff5e5b?style=flat)](https://github.com/AEON-7/AEON-7#-support-the-work)
Headless Matrix WebRTC voice call agent. Auto-answers (and initiates) Matrix VoIP calls with real-time voice conversation.

Call your AI agent from any Matrix client. The agent hears you, thinks, and talks back — **fully offline in ~2.1 s** with the recommended local Qwen stack on a DGX Spark, or in ~4 s with the cloud-fallback path.

## ✨ Best fully-offline voice stack — recommended pairing

For the lowest latency and zero cloud dependency, pair this agent with our three companion sidecars on a single GPU host (DGX Spark / Blackwell):

| sidecar | image | what it does |
|---|---|---|
| **[qwen3-asr-server](https://github.com/AEON-7/qwen3-asr-server)** | `ghcr.io/aeon-7/qwen3-asr-server:latest` | Speech → text (Qwen3-ASR-0.6B, RTF 16× hot) |
| **[qwen3-tts-server](https://github.com/AEON-7/qwen3-tts-server)** | `ghcr.io/aeon-7/qwen3-tts-server:latest` | Text → speech (Qwen3-TTS-12Hz-1.7B-VoiceDesign, RTF 1.30× hot) |
| **LLM main** — [Qwen3.6-27B AEON Ultimate MTP-XS](https://github.com/AEON-7/Qwen3.6-27B-AEON-Ultimate-Uncensored-DFlash) | `ghcr.io/aeon-7/vllm-aeon-ultimate-dflash:qwen36-v3` | Reasoning / chat (NVFP4 + DFlash) |

End-to-end voice turn: **~2.1 s** on Spark, with no audio ever leaving your network. Full setup walkthrough → **[docs/FULLY-OFFLINE-VOICE.md](docs/FULLY-OFFLINE-VOICE.md)**.

The agent also supports **whisper.cpp** (local CPU, no GPU), **OpenAI Realtime** (cloud STT), and **ElevenLabs** (cloud TTS) as fallbacks — backend selection is a single env var per leg (`STT_BACKEND` / `TTS_BACKEND`). Pick whatever suits you.

---

## 🎯 What this unlocks — capabilities you don't get elsewhere

This isn't "voice in / voice out." Pairing this agent with the local Qwen stack opens up a handful of capabilities that are genuinely hard to get from any cloud voice API stitched together:

### 🎙️ Hears more than just words

Qwen3-ASR captures **paralinguistic cues** — laughter, sighs, gasps of surprise, exclamations, hesitation, filler utterances — not just the literal transcript. Your agent knows when you're joking vs serious, excited vs frustrated, certain vs hesitant. The conversation has the *texture* of human speech, not just the words.

### 🎭 Speaks with matching expression

Qwen3-TTS-VoiceDesign generates the corresponding expressive cues on the way back — laughter, dramatic pauses, varied prosody, sighs of mock exasperation. Combined with the ASR's emotional understanding, the agent feels like it's *participating* in the conversation, not narrating at you.

### 🎨 Voice morphs mid-conversation

VoiceDesign accepts a free-form natural-language voice description on **every** request. The agent's voice isn't locked at startup — mid-call it can shift from *"warm, gravelly storyteller"* to *"crisp, clinical technical assistant"* by changing one string. Adapt the voice to the topic, the user's mood, or even the current persona. Try this with any cloud TTS — you'll hit a fixed catalog of voice IDs.

### 🌐 Real-time translation across dozens of languages

Qwen3-ASR speaks **30 languages + 22 Chinese dialects**; Qwen3-TTS speaks **10 major languages**. End result: you talk in Spanish, the LLM reasons in English, the agent replies in French — all in the same call, no separate translation pipeline. Polyglot conversations work out of the box.

### ⚡ Sub-3-second turns via the "thinking off" trick

Reasoning models like Qwen 3.6 default to "thinking" before answering — great for complex prompts, devastating for conversation latency. **This stack disables thinking by default** (`chat_template_kwargs: { enable_thinking: false }` on every chat call) and **only re-enables it when the model is about to invoke a tool**. That single config choice cuts the LLM leg from ~3 s to **~480 ms** on Qwen3.6-27B + DFlash, which is what makes the 2.1-second end-to-end voice turn possible.

### 🔁 Full-duplex, sentence-streamed conversation

Per-sentence streaming TTS means the agent starts speaking ~1.5 s after you finish — not after the *entire* response is generated. Combined with WebRTC's bidirectional audio plane, you can interrupt mid-reply and the agent keeps listening while it's speaking. No walkie-talkie pauses.

### 🌐 One Docker bridge, sub-millisecond hops

All four containers (LLM main + ASR + TTS + matrix-voip-agent if same host) join one shared bridge — `aeon-stack`. Inter-service calls stay on loopback, never crossing the network for the AI loop. Latency that would be 10-30 ms across separate hosts collapses to sub-ms. The setup is one `docker network create` away — fully automated by [`agents.md`](agents.md).

### 👥 Multi-room / multi-personality agents

Run multiple matrix-voip-agent instances on the same backend stack — each with its own bot account, system prompt, voice description, and PipeWire devices. One bot per Matrix room means each room can have a **dedicated agent with its own topic, personality, and conversation history**:

- `#help` → patient tech-support bot, neutral voice
- `#fiction` → enthusiastic creative-writing partner, warm storyteller voice
- `#engineering` → terse code-review bot, crisp technical voice
- `#meditation` → calm guided-meditation bot, soft slow-paced voice

All sharing the same LLM + ASR + TTS sidecars. No duplicate model loads, no GPU bloat — just one matrix-voip-agent process per personality.

### 💡 Spark deployment sweet spot

Co-locating all three sidecars on a single DGX Spark (128 GB unified) requires keeping the LLM main's `--gpu-memory-utilization` at **0.75** rather than the more typical 0.85+. That leaves ~10 GB for ASR and ~4 GB CUDA for TTS without OOM. Throughput cost is small; the deployment win — a complete voice agent in one box, no dedicated GPU per service — is huge. Full memory budget table and tuning matrix in [docs/FULLY-OFFLINE-VOICE.md](docs/FULLY-OFFLINE-VOICE.md).

---

## Choose Your Installation Path

### Path A: I already have a Matrix server

You have a working Matrix homeserver (Dendrite, Synapse, Conduit) with a TURN server configured. You just want to add voice agent capabilities.

```bash
git clone https://github.com/AEON-7/matrix-voip-agent.git
cd matrix-voip-agent
bash setup.sh
```

The setup script installs all voice agent dependencies (whisper.cpp, PipeWire, Node.js) and walks you through connecting to your existing Matrix server.

After install completes, point your AI agent to **[AGENT.md](AGENT.md)** — it contains everything the agent needs to start making and receiving voice calls, using tools, and reading transcripts.

**[Jump to Path A details](#path-a-add-voice-agent-to-existing-matrix-server)**

### Path B: I want the full turnkey setup

You don't have a Matrix server yet. This path sets up **everything from scratch** — a fully federated Matrix homeserver with encrypted messaging, TURN server for voice/video, automatic TLS certificates, dynamic DNS, and the AI voice agent — all on a single machine.

```bash
git clone https://github.com/AEON-7/matrix-voip-agent.git
cd matrix-voip-agent
bash setup-homeserver.sh
bash setup.sh
```

Two scripts, fully automated. When they finish, you have a production Matrix server with an AI agent you can call.

After install completes, point your AI agent to **[AGENT.md](AGENT.md)** — it has the full API reference, tool catalog, and integration patterns so the agent can begin using its new voice calling and messaging capabilities immediately.

**[Jump to Path B details](#path-b-turnkey-matrix-server--voice-agent)**

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
- Port forwarding configured on your router — see the **[Firewall and Port Forwarding Guide](docs/firewall/)** for step-by-step instructions for your specific router

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

### Domain options

The homeserver setup supports four options — pick the one that fits:

| Option | Cost | Dynamic IP? | Setup | Best for |
|---|---|---|---|---|
| **Own domain** | Varies | You manage DNS | Point A record to your IP | Static IPs, full control |
| **DuckDNS** | Free | Yes, auto-updated | Create account at duckdns.org | Home servers with changing IPs |
| **No-IP** | Free (with renewal) | Yes, auto-updated | Create account at noip.com | Alternative to DuckDNS |
| **FreeDNS** | Free | Yes, auto-updated | Create account at freedns.afraid.org | Many domain choices |

All options get automatic TLS certificates from Let's Encrypt via Caddy. If you already own a domain with a static IP, option 1 is simplest — just point your A record and go.

### Ports and Firewall

The homeserver needs these ports forwarded from your router to the server (the setup script configures `ufw` on the server itself):

| Port | Protocol | Service | Required? |
|---|---|---|---|
| 443 | TCP | HTTPS (Caddy) | Yes |
| 8448 | TCP | Matrix federation | Yes for federation |
| 3478 | TCP + UDP | TURN/STUN (coturn) | Yes for voice/video calls |
| 5349 | TCP | TURNS (TLS) | Recommended |
| 49152-65535 | UDP | TURN relay range | Yes for voice/video calls |

**Need help configuring your router?** See the **[Firewall and Port Forwarding Guide](docs/firewall/)** for step-by-step instructions for UniFi, pfSense, OPNsense, OpenWRT, Eero, Netgear, Linksys, TP-Link, Asus, Google Nest, Starlink, and more.

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
┌──────────────────────────────────────────────────────────────────────┐
│                    matrix-voip-agent (this repo)                     │
│                                                                      │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────────────┐  │
│  │ WebRTC   │──>│ PipeWire │──>│   STT    │──>│ LLM (vLLM HTTP)  │  │
│  │ (werift) │   │ loopback │   │ backend  │   │  qwen36-aeon-xs  │  │
│  │ Opus↔PCM │<──│ sink/src │<──│          │<──│  on Spark        │  │
│  └──────────┘   └──────────┘   └──────────┘   └────────┬─────────┘  │
│       ↑                                                │            │
│       │                        ┌──────────┐            │            │
│  ┌────┴────┐                   │   TTS    │<───────────┘            │
│  │ Matrix  │                   │ backend  │                         │
│  │signaling│                   └──────────┘                         │
│  │m.call.* │                                                        │
│  └─────────┘                                                        │
└──────────────────────────────────────────────────────────────────────┘
                STT / TTS backends are env-selectable:
   ┌──────────────────────────────────────────────────────────────┐
   │ STT_BACKEND=qwen      → qwen3-asr-server  (LAN HTTP, RTF 16x)│ ← recommended (offline)
   │ STT_BACKEND=whisper   → whisper.cpp       (local CPU)        │
   │ STT_BACKEND=openai    → OpenAI Realtime   (cloud, paid)      │
   │                                                              │
   │ TTS_BACKEND=qwen      → qwen3-tts-server  (LAN HTTP, RTF 1.3x)│ ← recommended (offline)
   │ TTS_BACKEND=elevenlabs→ ElevenLabs        (cloud, paid)      │
   └──────────────────────────────────────────────────────────────┘
```

### Voice conversation flow — recommended (fully offline)

```
You speak into Element (~2 seconds of speech)
       │
       ▼ WebRTC audio stream
[matrix-voip-agent] Opus decode → PipeWire
       │
       ▼ pw-record (16kHz PCM, local VAD)
[qwen3-asr-server] HTTP /v1/audio/transcriptions, ~120ms (RTF 16x)
       │
       ▼ transcript text
[vLLM main] qwen36-ultimate-xs HTTP, thinking OFF, ~480ms
       │
       ▼ response text (streamed per sentence)
[qwen3-tts-server] HTTP /v1/audio/speech, ~1.48s for ~2s WAV (RTF 1.30x)
       │
       ▼ raw PCM (24kHz)
[PipeWire] → Opus encode → WebRTC
       │
       ▼
You hear the agent respond (~2.1s after you stop speaking)
```

### Voice conversation flow — fallback paths

```
[whisper.cpp local CPU + ElevenLabs cloud]: ~1.5s STT + ~1.7s LLM + ~0.4s TTS = ~4s
[OpenAI Realtime + ElevenLabs]:             ~0.5s STT + ~1.7s LLM + ~0.4s TTS = ~3s (cloud, paid)
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

### Backend selection

| Variable | Default | Description |
|---|---|---|
| `STT_BACKEND` | auto | `qwen` / `whisper` / `openai`. If unset, auto-detects in that order based on what's configured. |
| `TTS_BACKEND` | auto | `qwen` / `elevenlabs`. If unset, auto-detects in that order based on what's configured. |

### Qwen3-ASR — fully offline STT (recommended)

Set these to point at an [`aeon-7/qwen3-asr-server`](https://github.com/AEON-7/qwen3-asr-server) instance running on your GPU host (Spark / Blackwell). LAN-hop only, no cloud.

| Variable | Required | Default | Description |
|---|---|---|---|
| `QWEN_ASR_ENDPOINT` (or `ASR_ENDPOINT`) | When `STT_BACKEND=qwen` | — | OpenAI-compatible base URL, e.g. `http://192.168.1.116:8001/v1` |
| `QWEN_ASR_MODEL` | No | `qwen3-asr` | Served-model-name (matches `--served-model-name` on the server) |
| `QWEN_ASR_LANGUAGE` | No | `auto` | Language hint (`en`, `zh`, `ja`, ... or `auto`) |

### Qwen3-TTS — fully offline TTS (recommended)

Set these to point at an [`aeon-7/qwen3-tts-server`](https://github.com/AEON-7/qwen3-tts-server) instance running on your GPU host. Returns 24 kHz mono WAV; `voice` is a free-form natural-language voice description forwarded to qwen-tts as `instruct`.

| Variable | Required | Default | Description |
|---|---|---|---|
| `QWEN_TTS_ENDPOINT` (or `TTS_ENDPOINT`) | When `TTS_BACKEND=qwen` | — | OpenAI-compatible base URL, e.g. `http://192.168.1.116:8002/v1` |
| `QWEN_TTS_MODEL` | No | `qwen3-tts` | Served-model-name |
| `QWEN_TTS_VOICE` | No | *(neutral assistant voice)* | Free-form voice description, e.g. `"A warm, expressive adult voice with natural cadence."` |
| `QWEN_TTS_LANGUAGE` | No | (auto-detect) | Optional language hint (`en`, `zh`, `ja`, ...) |

### Whisper.cpp — local CPU STT (fallback)

Use this when you don't have a GPU host for `qwen3-asr-server`. Runs entirely on the matrix-voip-agent machine's CPU.

| Variable | Default | Description |
|---|---|---|
| `WHISPER_ENABLED` | `true` | Enable local whisper.cpp |
| `WHISPER_LANGUAGE` | `auto` | Language code or `auto` for detection |
| `WHISPER_MODEL_PATH` | `~/whisper.cpp/models/ggml-small.bin` | Path to GGML model file |
| `WHISPER_SERVER_BIN` | `~/whisper.cpp/build/bin/whisper-server` | Path to server binary |
| `WHISPER_SERVER_PORT` | `8178` | HTTP port for whisper-server |

### ElevenLabs — cloud TTS (fallback)

Cloud-paid alternative to `qwen3-tts-server`. Requires an internet round-trip per sentence.

| Variable | Required | Default | Description |
|---|---|---|---|
| `ELEVENLABS_API_KEY` | When `TTS_BACKEND=elevenlabs` | — | ElevenLabs API key |
| `ELEVENLABS_VOICE_ID` | When `TTS_BACKEND=elevenlabs` | — | Voice ID for TTS |
| `ELEVENLABS_MODEL` | No | `eleven_flash_v2_5` | TTS model |

### OpenAI Realtime — cloud STT (fallback)

| Variable | Default | Description |
|---|---|---|
| `OPENAI_API_KEY` | — | Only needed when `STT_BACKEND=openai` or as a final fallback |
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

---

## ☕ Support the work

If this release has been useful, tips are deeply appreciated — they go directly toward more compute, more models, and more open releases.

<table align="center">
  <tr>
    <td align="center" width="50%">
      <strong>₿ Bitcoin (BTC)</strong><br/>
      <img src="https://raw.githubusercontent.com/AEON-7/AEON-7/main/assets/qr/btc.png" alt="BTC QR" width="200"/><br/>
      <sub><code>bc1q09xmzn00q4z3c5raene0f3pzn9d9pvawfm0py4</code></sub>
    </td>
    <td align="center" width="50%">
      <strong>Ξ Ethereum (ETH)</strong><br/>
      <img src="https://raw.githubusercontent.com/AEON-7/AEON-7/main/assets/qr/eth.png" alt="ETH QR" width="200"/><br/>
      <sub><code>0x1512667F6D61454ad531d2E45C0a5d1fd82D0500</code></sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <strong>◎ Solana (SOL)</strong><br/>
      <img src="https://raw.githubusercontent.com/AEON-7/AEON-7/main/assets/qr/sol.png" alt="SOL QR" width="200"/><br/>
      <sub><code>DgQsjHdAnT5PNLQTNpJdpLS3tYGpVcsHQCkpoiAKsw8t</code></sub>
    </td>
    <td align="center" width="50%">
      <strong>ⓜ Monero (XMR)</strong><br/>
      <img src="https://raw.githubusercontent.com/AEON-7/AEON-7/main/assets/qr/xmr.png" alt="XMR QR" width="200"/><br/>
      <sub><code>836XrSKw4R76vNi3QPJ5Fa9ugcyvE2cWmKSPv3AhpTNNKvqP8v5ba9JRL4Vh7UnFNjDz3E2GXZDVVenu3rkZaNdUFhjAvgd</code></sub>
    </td>
  </tr>
</table>

> **Ethereum L2s (Base, Arbitrum, Optimism, Polygon, etc.) and EVM-compatible tokens** can be sent to the same Ethereum address.
