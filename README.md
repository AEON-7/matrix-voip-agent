# Matrix VoIP Voice and Video Calling

[![☕ Tips](https://img.shields.io/badge/%E2%98%95_Tips-Support_the_work-ff5e5b?style=flat)](https://github.com/AEON-7/AEON-7#-support-the-work)

Headless Matrix WebRTC voice **and video** call agent. Auto-answers (and initiates) Matrix VoIP calls with real-time voice conversation powered by local STT, direct LLM inference, and local or cloud TTS.

Call your AI agent from any Matrix client. The agent hears you, thinks, and talks back — in ~4 seconds with the whisper.cpp + ElevenLabs pipeline, or ~2 seconds with the local [qwen3-asr-server](https://github.com/AEON-7/qwen3-asr-server) + [qwen3-tts-server](https://github.com/AEON-7/qwen3-tts-server) sidecars.

**Optional video add-on:** share your camera during a classic 1:1 Element video call and the agent can *see*. Inbound VP8 frames are sampled into a small in-memory JPEG ring buffer (never written to disk), and the LLM gets a per-call `look` tool to pull frames on demand — ask "what do you see?" and a vision-capable model answers from live camera frames. Off by default; voice-only calls behave exactly as before. See the [Video Calling QuickStart](#video-calling-quickstart-optional-add-on).

## ✨ Best fully-offline voice stack — recommended pairing

For the lowest latency and zero cloud dependency, pair this agent with our three companion sidecars on a single GPU host (DGX Spark / Blackwell):

| sidecar | image | what it does |
|---|---|---|
| **[qwen3-asr-server](https://github.com/AEON-7/qwen3-asr-server)** | `ghcr.io/aeon-7/qwen3-asr-server:latest` | Speech → text (Qwen3-ASR-0.6B, RTF 16× hot) — wired via `OMNI_ASR_*` |
| **[qwen3-tts-server](https://github.com/AEON-7/qwen3-tts-server)** | `ghcr.io/aeon-7/qwen3-tts-server:latest` | Text → speech (Qwen3-TTS-12Hz-1.7B-VoiceDesign, RTF 1.30× hot) — wired via `VOXTRAL_*` |
| **LLM main** — [Qwen3.6-27B AEON Ultimate MTP-XS](https://github.com/AEON-7/Qwen3.6-27B-AEON-Ultimate-Uncensored-DFlash) | `ghcr.io/aeon-7/vllm-aeon-ultimate-dflash:qwen36-v3` | Reasoning / chat (NVFP4 + DFlash) — wired via `VLLM_*` |

End-to-end voice turn: **~2.1 s** on Spark, with no audio ever leaving your network. Full sidecar walkthrough → **[docs/FULLY-OFFLINE-VOICE.md](docs/FULLY-OFFLINE-VOICE.md)**; whole-stack runbook → **[AGENTS.md](AGENTS.md)**.

The agent also supports **whisper.cpp** (local CPU, no GPU), **OpenAI Realtime** (cloud STT), and **ElevenLabs** (cloud TTS) as fallbacks — each leg is switched per env var (`OMNI_ASR_ENABLED` / `WHISPER_ENABLED` for STT, `VOXTRAL_ENABLED` / `ELEVENLABS_API_KEY` for TTS). Pick whatever suits you.

## 🎯 What this unlocks — capabilities you don't get elsewhere

This isn't "voice in / voice out." Pairing this agent with the local Qwen stack opens up capabilities that are genuinely hard to get from any cloud voice API stitched together:

### 👁️ Sees through the camera (video add-on)

Place a video call and the agent gains eyes: a `look` tool pulls live camera frames into a vision-capable LLM mid-conversation. Show it a circuit board, a plant, an error on another screen — and ask. Frames stay in RAM and die with the call.

### 🎙️ Hears more than just words

Qwen3-ASR captures **paralinguistic cues** — laughter, sighs, gasps of surprise, exclamations, hesitation, filler utterances — not just the literal transcript. Your agent knows when you're joking vs serious, excited vs frustrated, certain vs hesitant.

### 🎭 Speaks with matching expression

Qwen3-TTS-VoiceDesign generates the corresponding expressive cues on the way back — laughter, dramatic pauses, varied prosody, sighs of mock exasperation. The agent feels like it's *participating* in the conversation, not narrating at you.

### 🎨 Voice morphs mid-conversation

VoiceDesign accepts a free-form natural-language voice description on **every** request (`VOXTRAL_VOICE_DESCRIPTION`). The agent's voice isn't locked at startup — mid-call it can shift from *"warm, gravelly storyteller"* to *"crisp, clinical technical assistant"* by changing one string. Try this with any cloud TTS — you'll hit a fixed catalog of voice IDs.

### 🌐 Real-time translation across dozens of languages

Qwen3-ASR speaks **30 languages + 22 Chinese dialects**; Qwen3-TTS speaks **10 major languages**. You talk in Spanish, the LLM reasons in English, the agent replies in French — all in the same call, no separate translation pipeline.

### ⚡ Sub-3-second turns via the "thinking off" trick

Reasoning models default to "thinking" before answering — great for complex prompts, devastating for conversation latency. This agent keeps thinking **off for casual chat** (`VLLM_VOICE_THINKING_MODE=auto` enables it only for genuinely hard questions), which cuts the LLM leg to ~480 ms on Qwen3.6-27B + DFlash. Tool-capable calls can reason about which tool to invoke (`VLLM_VOICE_TOOLS_THINKING=on`), and filler phrases — *"Let me check on that."* — cover the wait so the caller never wonders if the line went dead.

### 🔁 Full-duplex, sentence-streamed conversation

Per-sentence streaming TTS (`VOICE_TTS_RESPONSE_MODE=chunked`) means the agent starts speaking shortly after you finish — not after the *entire* response is generated. Combined with WebRTC's bidirectional audio plane, no walkie-talkie pauses.

### 👥 Multi-room / multi-personality agents

Run multiple matrix-voip-agent instances on the same backend stack — each with its own bot account, system prompt, voice description, and PipeWire devices. One bot per Matrix room means each room can have a **dedicated agent with its own topic, personality, and conversation history**:

- `#help` → patient tech-support bot, neutral voice
- `#fiction` → enthusiastic creative-writing partner, warm storyteller voice
- `#engineering` → terse code-review bot, crisp technical voice
- `#meditation` → calm guided-meditation bot, soft slow-paced voice

All sharing the same LLM + ASR + TTS sidecars. No duplicate model loads, no GPU bloat — just one agent process per personality. The per-persona systemd pattern is in [AGENTS.md](AGENTS.md#multi-persona-deployments).

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

> Deploying the **whole stack** — homeserver, TURN, STT/TTS sidecars, vLLM, and a fleet of per-persona agents? See **[AGENTS.md](AGENTS.md)** for the full-stack deployment runbook (written for AI agents and humans alike).

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
| **matrix-voip-agent** | AI voice agent with STT, LLM, and TTS (plus the optional video add-on) |

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
    │               └── /.well-known/* ──> Federation endpoints
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

## Video Calling QuickStart (optional add-on)

The video add-on lets the agent see through the caller's camera during a classic 1:1 Matrix video call. It is **off by default** and changes nothing for voice-only calls — the audio path is byte-identical with video disabled.

### Requirements

- **ffmpeg** on `PATH` (installed by `setup.sh`)
- A **vision-capable** OpenAI-compatible model behind `VLLM_BASE_URL` (tested with Gemma-4-26B multimodal on vLLM)
- **Element Web/Desktop classic 1:1 video calls** (legacy `m.call.*` signaling). Element Call / MatrixRTC group calls are not supported.

### How it works

When an incoming call offer contains a video m-line and `VIDEO_ENABLED=true`, the agent accepts video receive-only:

```
VP8 RTP ──> jitter buffer + depacketize (werift, whole frames)
        ──> one persistent ffmpeg per call:
            -vf fps=1,scale=512:-2  (excess frames dropped BEFORE decode)
        ──> MJPEG ──> in-memory ring buffer (last 8 JPEGs, never on disk)
```

The LLM decides when to look: a per-call `look` tool returns the freshest 1–4 frames as images, optionally spread over the last N seconds for motion context. For always-on vision, `VIDEO_AUTO_ATTACH=latest` attaches the freshest frame to every user turn instead — costlier in tokens, but zero extra latency when the model needs eyes constantly.

### Enable it (3 steps)

1. Set `VIDEO_ENABLED=true` in the agent's `.env`
2. Restart the agent: `systemctl --user restart matrix-voip-agent.service`
3. Place a **video call** from Element and ask: *"what do you see?"*

Expected log lines on a successful video call:

```
[call-session]  Offer contains video — added recvonly video transceiver
[frame-sampler] Video sampler started (fps=1, width=512, ring=8)
[frame-sampler] First video frame decoded (24681 bytes)
```

### Video configuration

| Variable | Default | Description |
|---|---|---|
| `VIDEO_ENABLED` | `false` | Master switch. Per-agent opt-in — `dist/` may be shared by many persona units |
| `VIDEO_FRAME_FPS` | `1` | Frames/sec kept by ffmpeg's `fps` filter. Frames above this rate are dropped **before** decode, so CPU cost stays flat regardless of the caller's camera frame rate |
| `VIDEO_FRAME_WIDTH` | `512` | Output JPEG width; height keeps aspect ratio |
| `VIDEO_RING_SIZE` | `8` | JPEGs retained in the per-call in-memory ring buffer |
| `VIDEO_AUTO_ATTACH` | `off` | `off` = the model pulls frames on demand via the `look` tool. `latest` = always-on vision: the freshest frame is attached to every user turn |
| `VIDEO_LOOK_IMAGE_ROLE` | `tool` | Where `look`'s image parts ride. Set `user` if your model's chat template rejects images inside tool messages |

### Troubleshooting

| Symptom | Fix |
|---|---|
| No `Offer contains video` log line | The offer carried no VP8 video m-line — place a **video** call (camera icon), not a voice call, from Element Web/Desktop |
| `Video sampler started` but no `First video frame decoded` | The decoder is starved of a keyframe. The sampler sends RTCP PLI keyframe requests automatically (at start, on first RTP, and on every 5 s stall) — if frames still never decode, suspect heavy packet loss or TURN relay issues |
| LLM rejects `look` results (chat template error on images in tool messages) | Set `VIDEO_LOOK_IMAGE_ROLE=user` so frames ride in a follow-up user message instead |
| `ffmpeg spawn failed, video sampling disabled` | Install ffmpeg (`sudo apt install ffmpeg`). Video failures are fail-soft — audio keeps working |

Validate the ffmpeg sampling path without placing a call:

```bash
npm run build && node scripts/smoke-video.mjs
```

### Privacy

Camera frames live **only in RAM**, in a small per-call ring buffer, and are discarded on hangup. Nothing is ever written to disk; call transcripts remain text-only.

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

With the video add-on enabled, a receive-only side path feeds camera frames to the LLM:

```
┌─────────────────────────────────────────────────────────────┐
│                  video add-on (optional)                     │
│                                                             │
│  VP8 RTP ──> depacketize ──> ffmpeg (1 per call) ──> JPEG   │
│  (werift)    (whole VP8      fps drop + scale +      ring   │
│              frames)         mjpeg encode            (RAM)  │
│                                                       │     │
│              look tool / VIDEO_AUTO_ATTACH=latest  <──┘     │
│              (frames ride to the LLM as image parts)        │
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
| `look` | "What do you see?" | "Let me take a look." |

`look` is registered per-call, only when the active call has a live video track — voice-only calls present the exact same tool list as before. It returns 1–4 camera frames from the in-memory ring buffer as images (`frames`, `spread_seconds` parameters).

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
| `MATRIX_DEVICE_ID` | No | `OPENCLAW_VOICE` | Fixed device ID for the bot session |
| `MATRIX_DEVICE_NAME` | No | `OpenClaw Voice` | Device name in Matrix sessions |
| `AUTHORIZED_USERS` | **Yes** | — | Comma-separated Matrix user IDs allowed to call |

### Matrix E2EE (encrypted rooms)

| Variable | Default | Description |
|---|---|---|
| `MATRIX_E2EE_ENABLED` | `true` | Enable Olm/Megolm encryption support |
| `MATRIX_E2EE_REQUIRED` | `false` | Refuse to operate in unencrypted rooms |
| `MATRIX_RECOVERY_KEY_FILE` | `./secrets/recovery-key.txt` | File containing the recovery key (keep `secrets/` out of git) |
| `MATRIX_CRYPTO_STORE_PASSWORD` | — | Passphrase for the local crypto store |
| `MATRIX_AUTO_CROSS_SIGN` | `true` | Auto cross-sign the device on startup |
| `MATRIX_RESTORE_KEY_BACKUP_ON_START` | `true` | Restore key backup at startup |
| `CRYPTO_STORE_PATH` | `./crypto-store` | Local crypto store directory |

### LLM (direct inference)

| Variable | Required | Default | Description |
|---|---|---|---|
| `VLLM_BASE_URL` | **Yes** | *(example LAN value — set your own)* | OpenAI-compatible API endpoint. Must serve a vision-capable model if you enable the video add-on |
| `VLLM_API_KEY` | No | — | API key for the LLM server (blank for local vLLM) |
| `VLLM_MODEL` | **Yes** | *(example value — set your own)* | Model name as served by the LLM server |
| `VLLM_SYSTEM_PROMPT` | No | *(built-in)* | Custom system prompt for voice conversations |
| `VLLM_TEMPERATURE` | No | `0` | Sampling temperature |
| `VLLM_VOICE_THINKING_MODE` | No | `auto` | `on`/`off`/`auto` — reasoning for hard questions |
| `VOICE_HISTORY_MAX_MESSAGES` | No | `24` | In-call history cap (trimmed to `VOICE_HISTORY_KEEP_MESSAGES`, default 12) |

### Whisper.cpp (local STT)

| Variable | Default | Description |
|---|---|---|
| `WHISPER_ENABLED` | `true` | Enable local whisper.cpp |
| `WHISPER_LANGUAGE` | `auto` | Language code or `auto` for detection |
| `WHISPER_MODEL_PATH` | `~/whisper.cpp/models/ggml-small.bin` | Path to GGML model file |
| `WHISPER_SERVER_BIN` | `~/whisper.cpp/build/bin/whisper-server` | Path to server binary |
| `WHISPER_SERVER_PORT` | `8178` | HTTP port for whisper-server |

### TTS backends (pick one)

Configure **one** TTS backend: the local Qwen3-TTS sidecar (recommended, lowest latency) or ElevenLabs cloud TTS.

**Local TTS — [qwen3-tts-server](https://github.com/AEON-7/qwen3-tts-server) (OpenAI-compatible `/v1/audio/speech`):**

| Variable | Default | Description |
|---|---|---|
| `VOXTRAL_ENABLED` | `false` | Use the local OpenAI-compatible TTS server |
| `VOXTRAL_BASE_URL` | *(example LAN value)* | TTS server base URL, e.g. `http://your-tts-server:8091/v1` |
| `VOXTRAL_VOICE` | `cheerful_female` | Voice name |
| `VOXTRAL_MODEL` | *(example value)* | Model name as served |
| `VOXTRAL_VOICE_DESCRIPTION` | — | VoiceDesign-style voice description |
| `VOXTRAL_LANGUAGE` | `English` | Synthesis language |

**Cloud TTS — ElevenLabs:**

| Variable | Required | Default | Description |
|---|---|---|---|
| `ELEVENLABS_API_KEY` | If used | — | ElevenLabs API key |
| `ELEVENLABS_VOICE_ID` | If used | — | Voice ID for TTS |
| `ELEVENLABS_MODEL` | No | `eleven_flash_v2_5` | TTS model |

### Alternate STT backends

Besides whisper.cpp, any OpenAI-compatible `/v1/audio/transcriptions` server works — e.g. [qwen3-asr-server](https://github.com/AEON-7/qwen3-asr-server):

| Variable | Default | Description |
|---|---|---|
| `OMNI_ASR_ENABLED` | `false` | Use an OpenAI-compatible ASR server instead of whisper.cpp |
| `OMNI_ASR_BASE_URL` | *(falls back to `VLLM_BASE_URL`)* | ASR server base URL |
| `OMNI_ASR_MODEL` | *(falls back to `VLLM_MODEL`)* | ASR model name |
| `OMNI_ASR_API_KEY` | — | API key if the server requires one |

### OpenAI (fallback STT)

| Variable | Default | Description |
|---|---|---|
| `OPENAI_API_KEY` | — | Only needed if whisper fails |
| `OPENAI_STT_MODEL` | `gpt-4o-transcribe` | Realtime transcription model |

### Video add-on

See the **[Video Calling QuickStart](#video-calling-quickstart-optional-add-on)** for the `VIDEO_*` knobs (`VIDEO_ENABLED`, `VIDEO_FRAME_FPS`, `VIDEO_FRAME_WIDTH`, `VIDEO_RING_SIZE`, `VIDEO_AUTO_ATTACH`, `VIDEO_LOOK_IMAGE_ROLE`).

### Voice persona and memory

| Variable | Default | Description |
|---|---|---|
| `VOICE_CALLER_NAME` | `caller` | Name the LLM uses for the caller |
| `VOICE_MEMORY_ENABLED` | `true` | Inject memory/persona files into the system prompt |
| `VOICE_MEMORY_PATHS` | *(OpenClaw workspace files)* | Comma-separated markdown files to inject |
| `VOICE_MEMORY_MAX_CHARS` | `12000` | Total memory budget |
| `VOICE_TTS_RESPONSE_MODE` | `chunked` | `chunked` speaks per sentence; `full` waits for the whole reply |

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

Running **multiple agent personas** from one build (shared `dist/`, per-persona `.env` + working directory)? See **[AGENTS.md](AGENTS.md#multi-persona-deployments)** for the parameterized unit pattern.

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
