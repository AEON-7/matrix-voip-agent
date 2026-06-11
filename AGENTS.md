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

## Hard rules for agents working in this repo

- **Never commit** `.env`, `.env.bak*`, `backups/`, `secrets/`, `crypto-store/`, `transcripts/`, or `*.b64` files — `.gitignore` enforces this; do not weaken it.
- Never use `git add -A` / `git add .` here; stage explicit paths.
- LAN IPs in docs must be clearly marked as examples.
