# AGENTS.md — Full-Stack Deployment Runbook

This file is a machine-readable deployment guide for AI agents (and humans) bringing up the **entire** voice + video AI stack from scratch: Matrix homeserver, TURN, the STT/TTS sidecars, the LLM endpoint, this agent, and per-persona fleets.

- To **integrate with or control an already-running agent** (outbound-call API, voice tools, transcripts), read **[AGENT.md](AGENT.md)** instead.
- For the user-facing install walkthrough, read **[README.md](README.md)**.

All commands assume a Linux host with a non-root user. Components are listed in dependency order — deploy top to bottom. The deep-dive companion for the GPU sidecar bring-up (Docker commands, latency budget, memory tuning) is **[docs/FULLY-OFFLINE-VOICE.md](docs/FULLY-OFFLINE-VOICE.md)**.

> **Example values:** any `192.168.x.x` address or `*.example.com` / `*.duckdns.org` domain in this file is a placeholder. Substitute your own hosts.

## What you can do autonomously vs. what needs a human

**Agent-handleable** — do these without asking: install packages and Docker, pull/start the sidecar containers, run `setup.sh` / `setup-homeserver.sh` (use `--auto` when `.env` is pre-populated), edit `.env`, build, restart systemd user units, tail journalctl, run every smoke test below.

**Human-required — STOP and escalate before continuing:**

- **Hardware procurement** — if the GPU host for steps 4–6 doesn't exist, ask the human to provision one (DGX Spark validated).
- **Domain name** (turnkey homeserver only) — owned domain or a free DuckDNS subdomain; the human chooses.
- **Public IP / router port forwarding** — the human must forward the ports in step 2 ([docs/firewall/](docs/firewall/) has per-router guides). Don't guess router config.
- **Email for Let's Encrypt** and **account passwords** (admin + bot) — the human chooses; don't generate.
- **Pre-existing homeserver credentials** (bring-your-own path) — homeserver URL, bot user ID, fresh access token.
- **Approval to switch voice backends** if a working whisper.cpp + ElevenLabs setup already exists.
- **API tokens for optional tools** (`BRAVE_SEARCH_API_KEY`, `ELEVENLABS_API_KEY`, ...) — created by the human on the provider's site.

---

## 0. Stack overview

| # | Component | Provides | Source |
|---|---|---|---|
| 1 | Prerequisites | Node 22+, ffmpeg, PipeWire, systemd user units | distro packages |
| 2 | Matrix homeserver | Call signaling, E2EE messaging, federation | Dendrite (via `setup-homeserver.sh`) or Synapse |
| 3 | TURN server | WebRTC NAT traversal | coturn (via `setup-homeserver.sh`) |
| 4 | STT server | OpenAI-compatible `/v1/audio/transcriptions` | [qwen3-asr-server](https://github.com/AEON-7/qwen3-asr-server) |
| 5 | TTS server | OpenAI-compatible `/v1/audio/speech` | [qwen3-tts-server](https://github.com/AEON-7/qwen3-tts-server) |
| 6 | LLM endpoint | OpenAI-compatible chat completions (vision-capable for video) | [vllm-ultimate-dgx-spark](https://github.com/AEON-7/vllm-ultimate-dgx-spark) or any vLLM/OpenAI-compatible server |
| 7 | matrix-voip-agent | Answers calls, runs the voice/video pipeline | this repo |
| 8 | Per-persona units | One agent identity per systemd user unit | this repo, `systemd/` |

Steps 4–6 can run on a separate GPU machine (e.g. a DGX Spark); everything else runs on the agent host.

---

## 1. Prerequisites (agent host)

```bash
# System packages
sudo apt update
sudo apt install -y ffmpeg pipewire pipewire-pulse curl git build-essential cmake

# Node.js 22+ (NodeSource, skip if already >= 20)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# systemd user units must survive logout
sudo loginctl enable-linger "$USER"
```

Verify:

```bash
node --version        # >= v20, v22 recommended
ffmpeg -version       # required for the video add-on
systemctl --user status pipewire   # must be active
```

`bash setup.sh` (step 7) installs these too, including the PipeWire virtual audio devices — this section exists so an agent can verify preconditions independently.

---

## 2. Matrix homeserver

Two options:

**Option A — turnkey Dendrite (recommended for new deployments).** This repo's `setup-homeserver.sh` deploys Dendrite + PostgreSQL + Caddy (automatic TLS) + coturn + a DynDNS updater, all in Docker, and creates the bot + admin accounts:

```bash
git clone https://github.com/AEON-7/matrix-voip-agent.git
cd matrix-voip-agent
bash setup-homeserver.sh
```

**Option B — existing Synapse / Dendrite / Conduit.** Any homeserver works. You need:
- A bot account + access token for the agent
- A TURN server wired into the homeserver config (step 3)

**Ports** (forward from your router to the homeserver — full per-router walkthroughs in [docs/firewall/](docs/firewall/)):

| Port | Protocol | Service |
|---|---|---|
| 443 | TCP | HTTPS (client API, reverse proxy) |
| 8448 | TCP | Matrix federation |
| 3478 | TCP + UDP | TURN/STUN |
| 5349 | TCP | TURNS (TLS) |
| 49152–65535 | UDP | TURN relay range |

---

## 3. TURN server (coturn)

Installed and wired automatically by `setup-homeserver.sh` (Option A). For an existing homeserver, configure coturn yourself and point the homeserver at it (`turn_uris` / `turn_shared_secret` in Synapse, `turn:` block in Dendrite).

Verify the homeserver hands out TURN credentials — the agent fetches them automatically:

```bash
curl -s https://your-homeserver.example.com/_matrix/client/v3/voip/turnServer \
  -H "Authorization: Bearer <MATRIX_ACCESS_TOKEN>" | python3 -m json.tool
# Expect: username, password, uris[], ttl
```

The TURN URI must resolve to the real server IP — not a CDN/proxied hostname (Cloudflare does not proxy UDP/TURN).

---

## 4. STT server — qwen3-asr-server

OpenAI-compatible `/v1/audio/transcriptions`, Qwen3-ASR served by vLLM (~120 ms per 2 s clip on a DGX Spark). Deploy per its README:

```bash
git clone https://github.com/AEON-7/qwen3-asr-server.git
# Follow that repo's deploy scripts (pre-built ghcr image available)
```

Wire it into this agent via the `OMNI_ASR_*` env vars:

```bash
OMNI_ASR_ENABLED=true
OMNI_ASR_BASE_URL=http://192.168.1.116:8500/v1   # example — your ASR host
OMNI_ASR_MODEL=qwen3-asr-0.6b                    # as served
WHISPER_ENABLED=false                            # optional: skip the local whisper.cpp path
```

**Fallback option:** local whisper.cpp (built by `setup.sh`, `WHISPER_*` vars) — no GPU server needed, higher latency.

---

## 5. TTS server — qwen3-tts-server

OpenAI-compatible `/v1/audio/speech` serving Qwen3-TTS-12Hz-1.7B (VoiceDesign + Base voice-clone) through the [faster-qwen3-tts](https://github.com/andimarafioti/faster-qwen3-tts) CUDA-graph engine. **Supports realtime streaming**: with `stream: true` it sends PCM/WAV chunks while still generating — measured on Spark: first audio ~0.4 s, ~1.7× realtime throughput (vs ~1.5 s full-WAV synthesis for a ~2 s reply non-streaming). Deploy per its README:

```bash
git clone https://github.com/AEON-7/qwen3-tts-server.git
# Follow that repo's deploy scripts (pre-built ghcr image available)
```

Wire it in via the `VOXTRAL_*` env vars (historical prefix — it speaks to any OpenAI-compatible speech endpoint):

```bash
VOXTRAL_ENABLED=true
VOXTRAL_BASE_URL=http://192.168.1.116:8002/v1    # example — your TTS host
VOXTRAL_STREAMING=true                           # stream PCM chunks as generated — first audio ~0.4 s
VOXTRAL_API_KEY=your-tts-token                   # bearer token, if the server requires auth
VOXTRAL_VOICE=cheerful_female
VOXTRAL_VOICE_DESCRIPTION="A warm, friendly female voice"   # VoiceDesign-style
```

**Fallback option:** ElevenLabs cloud TTS (`ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`).

---

## 6. LLM endpoint

Any OpenAI-compatible chat-completions endpoint works. For the **video add-on the model must be vision-capable** (accepts `image_url` content parts) — tested with Gemma-4-26B multimodal on vLLM.

Reference GPU stack for a DGX Spark: [vllm-ultimate-dgx-spark](https://github.com/AEON-7/vllm-ultimate-dgx-spark).

```bash
VLLM_BASE_URL=http://192.168.1.116:8000/v1       # example — your vLLM host
VLLM_API_KEY=                                    # blank for local vLLM
VLLM_MODEL=your-model-name                       # as served; vision-capable for video
```

Verify:

```bash
curl -s http://192.168.1.116:8000/v1/models | python3 -m json.tool   # example host
```

---

## 7. This agent

```bash
git clone https://github.com/AEON-7/matrix-voip-agent.git
cd matrix-voip-agent
bash setup.sh          # PipeWire devices, whisper.cpp (optional), npm install, guided .env
# -- or, fully manual: --
npm ci
npm run build
cp .env.example .env   # then fill in every <PLACEHOLDER> (see steps 2-6 above)
npm start              # foreground test run
```

Minimum required `.env` keys: `MATRIX_USER_ID`, `MATRIX_ACCESS_TOKEN`, `AUTHORIZED_USERS`, one STT backend, one TTS backend, and the `VLLM_*` trio. The full key reference lives in [.env.example](.env.example) and the README's Configuration Reference.

### Single-agent systemd unit

```bash
cp systemd/matrix-voip-agent.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now matrix-voip-agent.service
journalctl --user -u matrix-voip-agent.service -f
```

### Multi-persona deployments

Pattern: **one shared clone + build, one working directory per persona.** Each persona is its own Matrix account with its own `.env`, `secrets/`, `crypto-store/`, and `transcripts/`; all units execute the same shared `dist/`.

```bash
# Shared build (updated once for the whole fleet)
ls ~/matrix-voip-agent/dist/index.js

# Per-persona working dirs
mkdir -p ~/voip-agents/alice ~/voip-agents/bob
cp ~/matrix-voip-agent/.env.example ~/voip-agents/alice/.env   # fill per persona:
#   - its own MATRIX_USER_ID / MATRIX_ACCESS_TOKEN / MATRIX_DEVICE_ID
#   - its own API_PORT (unique per persona, e.g. 8179, 8180, ...)
#   - its own PIPEWIRE_* device names (unique per persona)
#   - VLLM_SYSTEM_PROMPT / VOICE_MEMORY_PATHS / VOXTRAL_VOICE for the personality
```

Template unit `~/.config/systemd/user/matrix-voip-agent@.service`:

```ini
[Unit]
Description=Matrix VoIP Agent (%i)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/node %h/matrix-voip-agent/dist/index.js
WorkingDirectory=%h/voip-agents/%i
Restart=always
RestartSec=5
Environment=XDG_RUNTIME_DIR=/run/user/%U

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now matrix-voip-agent@alice.service
systemctl --user enable --now matrix-voip-agent@bob.service
```

The agent loads `.env` from its **working directory**, so each instance gets its own identity from the shared build.

---

## 8. Video add-on enablement

Because `dist/` is shared by every persona unit, video is a **per-agent opt-in** via that persona's `.env` — enable it on one canary unit first:

```bash
# In the persona's .env
VIDEO_ENABLED=true
# Optional tuning: VIDEO_FRAME_FPS=1, VIDEO_FRAME_WIDTH=512, VIDEO_RING_SIZE=8,
#                  VIDEO_AUTO_ATTACH=off|latest, VIDEO_LOOK_IMAGE_ROLE=tool|user

systemctl --user restart matrix-voip-agent@alice.service
```

Preconditions: ffmpeg on `PATH`, vision-capable `VLLM_MODEL`, callers using Element Web/Desktop classic 1:1 video calls (legacy `m.call.*`; Element Call/MatrixRTC is not supported). Full knob table, expected log lines, and troubleshooting: [README — Video Calling QuickStart](README.md#video-calling-quickstart-optional-add-on).

---

## 9. Smoke tests

In order, cheapest first:

```bash
# 1. Build + video sampling path (no call, no Matrix needed; requires ffmpeg)
npm run build && node scripts/smoke-video.mjs        # expect: PASS, >=2 JPEG frames

# 2. Agent boots and registers (watch for "Video: enabled=..." and tool list)
journalctl --user -u matrix-voip-agent.service -f

# 3. Voice call: from Element, voice-call the bot, say "what time is it?"
#    Expect a spoken answer; transcript lands in transcripts/ on hangup.

# 4. Video call (if VIDEO_ENABLED=true): video-call the bot, ask "what do you see?"
#    Expect logs: "Offer contains video" -> "Video sampler started" -> "First video frame decoded"

# 5. Outbound call API
curl -X POST http://127.0.0.1:8179/call \
  -H "Authorization: Bearer <API_TOKEN>" -H "Content-Type: application/json" \
  -d '{"roomId": "!room:your-homeserver.example.com", "userId": "@you:your-homeserver.example.com", "greeting": "Smoke test."}'
```

---

## 10. Update and rollback

**Update (rolling restart across a fleet):**

```bash
cd ~/matrix-voip-agent

# Backup the current build first
tar -czf ~/backups/matrix-voip-agent-$(date +%Y%m%dT%H%M%S).tar.gz dist/ package-lock.json

git pull
npm ci
npm run build

# Restart the canary unit, verify with a test call, then roll the rest
systemctl --user restart matrix-voip-agent@alice.service
journalctl --user -u matrix-voip-agent@alice.service -n 50
for u in $(systemctl --user list-units 'matrix-voip-agent*' --plain --no-legend | awk '{print $1}'); do
  systemctl --user restart "$u"; sleep 5
done
```

**Rollback:**

```bash
cd ~/matrix-voip-agent
rm -rf dist/
tar -xzf ~/backups/matrix-voip-agent-<TIMESTAMP>.tar.gz
systemctl --user restart matrix-voip-agent.service   # or roll all units as above
```

`git revert` + rebuild is the durable alternative once the regression is identified. Persona state (`.env`, `crypto-store/`, `secrets/`, `transcripts/`) lives outside `dist/` and is untouched by either path.

---

## 11. Runtime integration guide (using the deployed agent)

> Merged from the former `AGENT.md` — the API reference, voice-tool catalog, transcript format,
> and integration patterns an AI agent needs to *use* a deployed instance (vs. deploy it).

This file is for AI agents (OpenClaw, Claude Code, etc.) that need to integrate with or control the matrix-voip-agent voice call system. Read this file to understand the system's capabilities, APIs, and how to interact with it.

> Deploying the system itself (homeserver, TURN, STT/TTS sidecars, LLM, per-persona units)? That runbook is **[AGENTS.md](AGENTS.md)**.

---

### What This System Does

This is a headless voice (and optionally video) call agent for Matrix. It answers incoming VoIP calls and can initiate outbound calls. During a call, it:

1. Listens to the caller via WebRTC
2. Transcribes speech locally (whisper.cpp, or an OpenAI-compatible ASR server such as qwen3-asr-server)
3. Sends the transcript to an LLM (via OpenAI-compatible API)
4. Speaks the LLM response back via TTS (an OpenAI-compatible TTS server such as qwen3-tts-server, or ElevenLabs)
5. Saves a full transcript when the call ends

With the video add-on enabled (`VIDEO_ENABLED=true`) and a classic 1:1 video call, the agent also samples camera frames into an in-memory ring buffer and the LLM can see through the caller's camera via the `look` tool. Frames are never written to disk; transcripts stay text-only.

The voice pipeline bypasses Matrix for the conversation loop — Matrix is only used for call signaling (ringing, answering, hanging up).

---

### How to Make the Agent Call Someone

Send an HTTP POST to the voice agent's API:

```bash
curl -X POST http://127.0.0.1:8179/call \
  -H "Authorization: Bearer API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "roomId": "!roomid:homeserver",
    "userId": "@user:homeserver",
    "greeting": "Hey, I wanted to let you know your build finished successfully."
  }'
```

**Parameters:**
- `roomId` (required): The Matrix room ID where the call will be placed. Must be a DM room with the target user.
- `userId` (required): The Matrix user ID to call.
- `greeting` (optional): What the agent says when the call connects. If omitted, defaults to a generic greeting.

**Response:**
```json
{"callId": "outbound-1234567890-abc123", "status": "invite_sent"}
```

The target user's Matrix client (Element) will ring. When they answer, the voice conversation begins.

---

### How to End a Call

```bash
curl -X POST http://127.0.0.1:8179/hangup \
  -H "Authorization: Bearer API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"callId": "outbound-1234567890-abc123"}'
```

---

### How to Check Active Calls

```bash
curl http://127.0.0.1:8179/status \
  -H "Authorization: Bearer API_TOKEN"
```

Response: `{"activeCalls": 0}`

---

### API Details

| Endpoint | Method | Auth | Body | Description |
|---|---|---|---|---|
| `/call` | POST | Bearer token | `{roomId, userId, greeting?}` | Initiate outbound call |
| `/hangup` | POST | Bearer token | `{callId}` | End a call |
| `/status` | GET | Bearer token | — | Active call count |

- **Base URL**: `http://127.0.0.1:8179` (configurable via `API_PORT` env var)
- **Auth**: `Authorization: Bearer <API_TOKEN>` header (token from `.env`)

---

### Voice Tools Available During Calls

When the agent is on a call, the LLM has these tools available:

| Tool | Description | Use when |
|---|---|---|
| `get_current_time` | Returns current date and time | Caller asks about the time or date |
| `check_server_status` | Checks if the vLLM server is healthy | Caller asks about server or infrastructure status |
| `run_command` | Runs a shell command and returns output | Caller asks about system info (disk, uptime, processes) |
| `web_search` | Searches the web via Brave Search | Caller asks about news, weather, facts, current events |
| `send_message` | Sends a text message to the Matrix room | Caller asks to post something in the chat |
| `look` | Returns 1–4 camera frames from the in-memory ring buffer as images (`frames`, `spread_seconds`) | Video calls only — registered per-call when the call has a live video track. Caller asks "what do you see?" or shows something to the camera |

Tools execute in the background while the agent speaks a filler phrase (e.g., "Let me check on that."). The tool result is then used to generate the spoken response.

---

### Call Transcripts

After every call, transcripts are saved to:

- `~/matrix-voip-agent/transcripts/call-YYYY-MM-DD_HH-MM-SS.md` — Human-readable markdown
- `~/matrix-voip-agent/transcripts/call-YYYY-MM-DD_HH-MM-SS.json` — Machine-readable JSON

#### JSON transcript format:
```json
{
  "callStart": "2026-03-29T07:00:00.000Z",
  "caller": "@user:your-homeserver.example.com",
  "sttMode": "whisper",
  "transcript": [
    {"timestamp": "2026-03-29T07:00:05.000Z", "speaker": "user", "text": "Hey, what time is it?"},
    {"timestamp": "2026-03-29T07:00:12.000Z", "speaker": "agent", "text": "It's 3 AM on Saturday, March 29th."}
  ]
}
```

---

### Service Management

The voice agent runs as a systemd user service:

```bash
# Check status
systemctl --user status matrix-voip-agent.service

# View live logs
journalctl --user -u matrix-voip-agent.service -f

# Restart
systemctl --user restart matrix-voip-agent.service

# Stop
systemctl --user stop matrix-voip-agent.service
```

---

### Key File Locations

| File | Purpose |
|---|---|
| `~/matrix-voip-agent/.env` | All configuration (credentials, endpoints, settings) |
| `~/matrix-voip-agent/transcripts/` | Call transcripts (markdown + JSON) |
| `~/matrix-voip-agent/src/tools/built-in.ts` | Voice tool definitions (add new tools here) |
| `~/matrix-voip-agent/src/llm/vllm-client.ts` | LLM client and system prompt |
| `~/matrix-voip-agent/src/voice-pipeline.ts` | Main voice pipeline orchestration |
| `~/.config/pipewire/pipewire.conf.d/` | PipeWire virtual audio device configs |
| `~/whisper.cpp/models/` | Whisper STT models |

---

### How to Add a New Voice Tool

Add a new tool in `src/tools/built-in.ts`:

```typescript
const myNewTool: VoiceTool = {
  name: "my_tool_name",
  description: "What this tool does (shown to the LLM)",
  parameters: {
    someParam: { type: "string", description: "Parameter description" },
  },
  fillerPhrase: "Working on that now.",
  async execute(args) {
    // Do something with args.someParam
    return "Result text that the LLM will use to formulate a spoken response";
  },
};
```

Then add it to the `BUILT_IN_TOOLS` array at the bottom of the file. Rebuild with `npm run build` and restart the service.

---

### System Prompt

The LLM uses a voice-optimized system prompt during calls. Key behaviors:

- Responses are short (1-3 sentences) since they'll be spoken aloud
- No markdown, bullet points, or formatting
- Natural conversational tone with contractions
- Uses tools when real-time information is needed
- Does NOT announce tool calls — the system handles filler phrases automatically

The system prompt can be customized via `VLLM_SYSTEM_PROMPT` in `.env`, or by editing `VOICE_SYSTEM_PROMPT` in `src/llm/vllm-client.ts`.

---

### Network Architecture

```
Voice agent (this machine):
  :8008  ← Matrix homeserver (Dendrite, localhost)
  :8178  ← whisper-server (auto-started per call, localhost)
  :8179  ← Voice agent API (outbound calls, localhost)
  :3478  ← coturn TURN server (LAN/public)

Remote (LAN or cloud):
  vLLM server       → LLM inference (OpenAI-compatible API; vision-capable model for video)
  qwen3-asr-server  → STT, OpenAI-compatible /v1/audio/transcriptions (optional, OMNI_ASR_*)
  qwen3-tts-server  → TTS, OpenAI-compatible /v1/audio/speech, streams PCM while generating (optional, VOXTRAL_*)
  ElevenLabs        → Text-to-speech (cloud API, alternative to local TTS)
  Brave Search      → Web search (cloud API, optional)
```

---

### Common Integration Patterns

#### Notify the user about something urgent
```bash
curl -X POST http://127.0.0.1:8179/call \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"roomId": "'$ROOM_ID'", "userId": "'$USER_ID'", "greeting": "Alert: the disk is 95 percent full on the production server."}'
```

#### Schedule a check-in call
```bash
# Using cron or a scheduler
echo "0 9 * * 1-5 curl -sX POST http://127.0.0.1:8179/call -H 'Authorization: Bearer TOKEN' -H 'Content-Type: application/json' -d '{\"roomId\":\"!room:server\",\"userId\":\"@user:server\",\"greeting\":\"Good morning! Here is your daily briefing.\"}'" | crontab -
```

#### Call after a long-running task completes
```bash
# At the end of a build script, deployment, etc.
./deploy.sh && curl -sX POST http://127.0.0.1:8179/call \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"roomId": "'$ROOM_ID'", "userId": "'$USER_ID'", "greeting": "Your deployment just finished. Everything looks good."}'
```

#### Read the latest transcript programmatically
```bash
# Get the most recent call transcript
cat ~/matrix-voip-agent/transcripts/$(ls -t ~/matrix-voip-agent/transcripts/*.json | head -1)
```

## Hard rules for agents working in this repo

- **Never commit** `.env`, `.env.bak*`, `backups/`, `secrets/`, `crypto-store/`, `transcripts/`, or `*.b64` files — `.gitignore` enforces this; do not weaken it.
- Never use `git add -A` / `git add .` here; stage explicit paths.
- LAN IPs in docs must be clearly marked as examples.
