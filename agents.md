# agents.md — autonomous deployment runbook

Instructions for an AI deployment agent (Claude Code, OpenClaw skill,
etc.) to bring the matrix-voip-agent stack up from scratch on fresh
hosts. Self-contained: you don't need to also read README.md.

> Note: there are **two** agent docs in this repo. This one (`agents.md`)
> covers **deploying** the stack. The other (`AGENT.md`) covers what the
> *deployed bot* can do at runtime (call API, tool catalog, integration
> patterns). Use `AGENT.md` after deployment is complete.

## Scope

This runbook brings up the **fully-offline voice agent stack** described
in [docs/FULLY-OFFLINE-VOICE.md](docs/FULLY-OFFLINE-VOICE.md):

```
GPU host (DGX Spark / Blackwell):       Matrix-voip-agent host (any Linux):
  - vLLM main         :8000              - matrix-voip-agent (this repo)
  - qwen3-asr-server  :8001              - PipeWire (audio plumbing)
  - qwen3-tts-server  :8002              - Matrix homeserver (optional turnkey)
                                         - coturn (optional turnkey)
```

Two valid topologies — pick before starting:

- **Single-host**: GPU host and matrix-voip-agent host are the same machine.
- **Two-host**: GPU host on the LAN serves the AI sidecars; a separate
  Linux box runs matrix-voip-agent + (optionally) the Matrix homeserver.

## Preconditions

### Agent-handleable (you can do these autonomously)

✅ Install Docker on either host (`curl https://get.docker.com | sh`).
✅ Install nvidia-container-toolkit if missing on the GPU host.
✅ Pull and start the three sidecar containers from `ghcr.io/aeon-7/...`.
✅ Run `setup.sh` (matrix-voip-agent installer) and `setup-homeserver.sh`
   (turnkey Dendrite + coturn + Caddy) **in `--auto` mode** when the
   human has pre-populated `.env` with the values you need.
✅ Edit `.env`, restart services via systemd, tail journalctl.
✅ Run smoke tests (curl, dial-the-bot via Matrix bot API).
✅ Read container/service logs for diagnosis.

### Human-required (STOP and escalate before continuing)

❌ **Hardware procurement.** If the GPU host doesn't exist yet, ask the
   human to provision one (DGX Spark validated; any Blackwell consumer
   GPU should work). Confirm specs: ≥ 110 GB RAM, NVIDIA GPU, Docker
   with `nvidia` runtime configured.
❌ **Domain name** (only for Path B / turnkey homeserver). The human
   must either own one or be willing to register a free DuckDNS
   subdomain. Ask: *"Do you have a domain to use for the Matrix
   homeserver, or should we use a free DuckDNS subdomain?"*
❌ **Public IP / port forwarding** (Path B only). The human must
   forward ports 443/TCP, 8448/TCP, 3478/TCP+UDP, 5349/TCP,
   49152-65535/UDP from their router to the matrix-voip-agent host.
   Reference: [docs/firewall/](docs/firewall/) has step-by-step
   instructions for ~12 router brands. Don't guess router config —
   ask the human.
❌ **Email address** for Let's Encrypt (Path B only).
❌ **Passwords** — admin password and bot password for the Matrix
   homeserver (Path B). Ask the human to choose; don't generate.
❌ **Pre-existing Matrix homeserver credentials** (Path A only) —
   homeserver URL, bot user ID, and a fresh access token. The bot
   account must already exist with VoIP permissions. Ask the human
   to create the account in Element first; you can't do this without
   their browser.
❌ **TURN server validation** (Path A only). If the human has an
   existing homeserver, confirm with them that coturn is configured
   and reachable — without it, calls only work on the same LAN.
   Verify with the curl in [`README.md → TURN server requirement`](README.md#turn-server-requirement).
❌ **Approval to switch backends** if the human has an existing
   whisper.cpp + ElevenLabs setup running. The fully-offline path
   replaces both. Ask before changing.
❌ **API tokens for optional tools** (`BRAVE_SEARCH_API_KEY` etc.).
   The human creates these on the provider's site.

## Decision points — commit BEFORE running any deploy command

### 1. Topology — single-host or two-host?

- **Single-host**: GPU + agent on one machine. Simplest. Pick when the
  GPU host runs Linux and has PipeWire + audio access.
- **Two-host**: separate GPU box on the LAN. Pick when the GPU host
  is headless (no audio stack) or the human wants to keep voice
  agent code off the GPU box.

**If unsure**: ask the human. Don't guess.

### 2. Matrix homeserver — bring-your-own or turnkey?

- **Path A (bring-your-own)**: human already has a Matrix homeserver
  (Synapse / Conduit / Dendrite) with TURN configured. Skips
  `setup-homeserver.sh`. Run only `setup.sh`.
- **Path B (turnkey)**: this repo's `setup-homeserver.sh` deploys
  Dendrite + coturn + Caddy + DynDNS in Docker on the
  matrix-voip-agent host. Requires the domain + ports + Let's
  Encrypt email from the "Human-required" preconditions above.

**If unsure**: ask the human. Path B is more setup but gives them
a complete stack; Path A integrates with what they have.

### 3. Voice backend — fully offline (recommended) or cloud fallback?

Default: **fully offline** (`STT_BACKEND=qwen`, `TTS_BACKEND=qwen`).
Only deviate if:

- The human said "I don't have a GPU" → `STT_BACKEND=whisper` (local
  CPU) + `TTS_BACKEND=elevenlabs` (cloud, requires API key from human).
- The human said "I want the lowest latency, paid-cloud is fine" →
  `STT_BACKEND=openai` + `TTS_BACKEND=elevenlabs` (both cloud).

If unsure: stick with fully offline. See
[docs/FULLY-OFFLINE-VOICE.md](docs/FULLY-OFFLINE-VOICE.md) for the
full rationale.

### 4. Which Qwen model variants?

For the recommended fully-offline path:

- **TTS**: default `Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign`. Only
  deviate if the human asked for voice cloning (Base variants) or a
  fixed catalog of speakers (CustomVoice variants). See
  [qwen3-tts-server MODELS.md](https://github.com/AEON-7/qwen3-tts-server/blob/main/docs/MODELS.md).
- **ASR**: default `Qwen/Qwen3-ASR-0.6B`. Only deviate if the human
  asked for "best WER / accuracy" → 1.7B. See
  [qwen3-asr-server MODELS.md](https://github.com/AEON-7/qwen3-asr-server/blob/main/docs/MODELS.md).

## Phase 1 — GPU host bring-up (fully-offline path only)

Skip this entire phase if `STT_BACKEND` and `TTS_BACKEND` are both
non-`qwen`.

Run on the GPU host (or pre-arrange SSH access from the
matrix-voip-agent host).

```bash
# Verify preconditions
docker info | grep -i 'runtime' | grep -q nvidia \
  || { echo "FAIL: nvidia runtime not configured"; exit 1; }
nvidia-smi >/dev/null 2>&1 || nvidia-ctk version >/dev/null 2>&1 \
  || { echo "FAIL: no NVIDIA driver detected"; exit 1; }
free -g | awk '/^Mem:/ { if ($2 < 110) { print "WARN: <110GB RAM ("$2"GB) — sidecars may not co-fit"; } }'

# Shared bridge
docker network create aeon-stack 2>/dev/null || true

# 1a. LLM main (heaviest — start first)
docker run -d --name qwen36-aeon-xs \
  --runtime nvidia --network aeon-stack -p 8000:8000 \
  --shm-size=4gb --restart unless-stopped \
  -v ${HOME}/.cache/huggingface:/root/.cache/huggingface \
  -e NVIDIA_VISIBLE_DEVICES=all \
  -e ENABLE_NVFP4_SM100=0 \
  -e VLLM_NVFP4_GEMM_BACKEND=flashinfer-cutlass \
  -e VLLM_USE_FLASHINFER_MOE_FP4=0 \
  -e VLLM_USE_FLASHINFER_SAMPLER=1 \
  ghcr.io/aeon-7/vllm-aeon-ultimate-dflash:qwen36-v3 \
  vllm serve aeon-7/Qwen3.6-27B-AEON-Ultimate-Uncensored-MTP-XS \
    --served-model-name qwen36-ultimate-xs \
    --host 0.0.0.0 --port 8000 \
    --gpu-memory-utilization 0.75 \
    --max-model-len 32768 \
    --enable-auto-tool-choice --tool-call-parser qwen3_coder \
    --reasoning-parser qwen3 \
    --speculative-config '{"method":"dflash","model":"z-lab/Qwen3.6-27B-DFlash","num_speculative_tokens":15}' \
    --trust-remote-code

# 1b. ASR sidecar
docker run -d --name qwen3-asr \
  --runtime nvidia --network aeon-stack -p 8001:8001 \
  --shm-size=4gb --restart unless-stopped \
  -v ${HOME}/.cache/huggingface:/root/.cache/huggingface \
  -e NVIDIA_VISIBLE_DEVICES=all \
  ghcr.io/aeon-7/qwen3-asr-server:latest

# 1c. TTS sidecar
docker run -d --name qwen3-tts \
  --runtime nvidia --network aeon-stack -p 8002:8002 \
  --shm-size=4gb --restart unless-stopped \
  -v ${HOME}/.cache/huggingface:/root/.cache/huggingface \
  -e NVIDIA_VISIBLE_DEVICES=all \
  ghcr.io/aeon-7/qwen3-tts-server:latest

# 1d. Wait for all three (LLM is the slowest — ~3 min cold)
echo "Waiting for LLM main..."
until curl -sf -m 2 http://localhost:8000/health >/dev/null; do sleep 5; done
echo "Waiting for ASR..."
until curl -sf -m 2 http://localhost:8001/health >/dev/null; do sleep 5; done
echo "Waiting for TTS..."
until curl -sf -m 2 http://localhost:8002/health 2>/dev/null | grep -q model_loaded; do sleep 2; done
echo "All three sidecars ready"

# 1e. Smoke test
curl -sf http://localhost:8002/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3-tts","input":"deployment test","response_format":"wav"}' \
  --output /tmp/deploy_smoke.wav
[[ -s /tmp/deploy_smoke.wav ]] || { echo "FAIL: TTS produced no audio"; exit 1; }
ASR_OUT=$(curl -sf -X POST http://localhost:8001/v1/audio/transcriptions \
            -F file=@/tmp/deploy_smoke.wav -F model=qwen3-asr -F language=en)
echo "$ASR_OUT" | grep -q '"text"' || { echo "FAIL: ASR error: $ASR_OUT"; exit 1; }
echo "GPU host ready: $ASR_OUT"
```

If anything fails: see "Common failures" below before bothering the human.

Note the GPU host's LAN IP — you'll need it as `SPARK_HOST` in Phase 3.
The agent should ask `ip route get 1.1.1.1 | awk '{print $7; exit}'`
to discover it on the GPU host.

## Phase 2 — Matrix homeserver (Path B only)

Skip this phase entirely if the human chose Path A (bring-your-own
homeserver).

Run on the matrix-voip-agent host:

```bash
git clone https://github.com/AEON-7/matrix-voip-agent
cd matrix-voip-agent
bash setup-homeserver.sh
```

> ⚠️ This script is **interactive** by design — it asks for the human's
> domain choice, Let's Encrypt email, admin/bot passwords, and DynDNS
> credentials. **Do not pipe `yes` to it or try to automate the prompts.**
> Hand the terminal to the human, or pre-stage answers in env vars
> (`DOMAIN=...`, `LE_EMAIL=...`, etc. — see the script's top-of-file
> comments for the full list).

When it finishes, capture from the script's output:

- The `MATRIX_HOMESERVER_URL` (e.g. `https://your-domain.duckdns.org`)
- The bot's `MATRIX_USER_ID` (e.g. `@celina:your-domain.duckdns.org`)
- The bot's `MATRIX_ACCESS_TOKEN`
- An admin Matrix user ID for `AUTHORIZED_USERS`

You'll need these for `.env` in Phase 3.

## Phase 3 — matrix-voip-agent install + .env wiring

Run on the matrix-voip-agent host:

```bash
# Skip the clone if you already did it in Phase 2
[ -d matrix-voip-agent ] || git clone https://github.com/AEON-7/matrix-voip-agent
cd matrix-voip-agent

# Pre-stage .env BEFORE running setup.sh so it can use --auto mode.
# (setup.sh prompts for credentials interactively if .env is missing values.)
cat > .env <<EOF
# === Backend selection — fully offline (recommended) ===
STT_BACKEND=qwen
TTS_BACKEND=qwen

# === GPU host (substitute the actual LAN IP) ===
SPARK_HOST=192.168.1.116      # discovered in Phase 1

# === Qwen3-ASR ===
QWEN_ASR_ENDPOINT=http://\${SPARK_HOST}:8001/v1
QWEN_ASR_MODEL=qwen3-asr
QWEN_ASR_LANGUAGE=en

# === Qwen3-TTS ===
QWEN_TTS_ENDPOINT=http://\${SPARK_HOST}:8002/v1
QWEN_TTS_MODEL=qwen3-tts
QWEN_TTS_VOICE=A warm, expressive adult voice with natural cadence.

# === LLM main ===
VLLM_BASE_URL=http://\${SPARK_HOST}:8000/v1
VLLM_API_KEY=ignored
VLLM_MODEL=qwen36-ultimate-xs

# === Matrix (from Phase 2 output, or human-provided for Path A) ===
MATRIX_HOMESERVER_URL=https://your-homeserver.example.org
MATRIX_USER_ID=@yourbot:your-homeserver.example.org
MATRIX_ACCESS_TOKEN=PLACEHOLDER_FROM_HUMAN_OR_PHASE_2
AUTHORIZED_USERS=@you:your-homeserver.example.org

# === Disable unused cloud paths ===
WHISPER_ENABLED=false

# === Outbound API ===
API_PORT=8179
API_TOKEN=$(openssl rand -hex 32)
EOF

# Now run installer in non-interactive mode
bash setup.sh --auto
```

The `--auto` flag tells `setup.sh` to skip all prompts and use only what
`.env` supplies. If any required field is missing, `setup.sh` exits
with an error naming the specific variable — don't proceed; **stop and
ask the human for the missing value**.

`setup.sh` installs:

- PipeWire + virtual audio devices (audio plumbing for the bot)
- Node.js 22 if not present
- Project dependencies (`npm install`)
- TypeScript build (`npm run build`)
- For `STT_BACKEND=whisper`: clones whisper.cpp, builds, downloads model.
  **Skipped automatically when `STT_BACKEND=qwen`.**

## Phase 4 — Start and verify

```bash
# Option 1: foreground (good for first-run debugging)
cd matrix-voip-agent
npm start
# Watch for these in the logs:
#   [voice-pipeline] TTS backend: qwen3-tts (http://...)
#   [voice-pipeline] Voice pipeline started (STT: qwen, ...)

# Option 2: systemd user service (production)
cp systemd/matrix-voip-agent.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now matrix-voip-agent.service
journalctl --user -u matrix-voip-agent.service -f
```

Wait for the agent to log `Logged in as @yourbot:...` and
`Listening for incoming calls`. That means it's joined Matrix and is
ready to answer.

### Smoke test — initiate an outbound call from the agent itself

```bash
# Replace with values from the human's Matrix account
curl -X POST http://127.0.0.1:8179/call \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "roomId": "!HUMAN_ROOM_ID:homeserver",
    "userId": "@HUMAN_USER:homeserver",
    "greeting": "This is a deployment smoke test. If you can hear me, the stack is working."
  }'
```

If the human's Matrix client rings and they hear the greeting in ~1-2 s
of dial-tone-to-speech: **deployment is complete**.

## Common failures and recovery

### Phase 1 — `qwen3-asr` boots and immediately exits

Container logs show `No available memory for the cache blocks`.
KV-cache shortfall. Fix:

```bash
docker rm -f qwen3-asr
docker run -d --name qwen3-asr \
  --runtime nvidia --network aeon-stack -p 8001:8001 --shm-size=4gb \
  -v ${HOME}/.cache/huggingface:/root/.cache/huggingface \
  -e NVIDIA_VISIBLE_DEVICES=all \
  ghcr.io/aeon-7/qwen3-asr-server:latest \
  vllm serve Qwen/Qwen3-ASR-0.6B \
    --served-model-name qwen3-asr \
    --host 0.0.0.0 --port 8001 \
    --gpu-memory-utilization 0.10 \   # was 0.08 — bump by 0.02
    --max-model-len 8192 --max-num-seqs 4 --trust-remote-code
```

Bump in 0.02 increments. If you reach `0.20` and still fail, lower
`--max-model-len` to `4096`.

### Phase 1 — All three sidecars never become ready

Total memory pressure. Check `free -g` and `docker stats`. Likely
needs the human to reduce co-resident services or move to a host with
more RAM. Don't try to "shrink" the LLM main below `--gpu-memory-utilization 0.70`
without asking — it'll OOM at runtime.

### Phase 3 — `setup.sh` exits with `Missing required env var`

Pre-staged `.env` is incomplete. Read the variable name in the error.
If it's a Matrix credential, the human must provide it. If it's a
SPARK_HOST or QWEN_*, you should have set it during Phase 1/3
prep — re-check.

### Phase 4 — Agent starts but immediately exits with `qwen3-asr endpoint did not respond`

LAN connectivity issue between matrix-voip-agent host and GPU host.
Verify:

```bash
curl http://${SPARK_HOST}:8001/health
```

If that fails, check firewalls (`ufw status`), the GPU host's
`docker ps`, and that the GPU host published port 8001 to `0.0.0.0`
(not just `127.0.0.1`).

### Phase 4 — Agent connects but voice calls don't ring

Matrix VoIP signaling issue. Two likely causes:

1. **TURN server missing/misconfigured**. Run the TURN check from
   `README.md → TURN server requirement`. If `uris` is empty, the
   homeserver isn't returning TURN credentials — the human must
   configure coturn.
2. **AUTHORIZED_USERS doesn't include the human's Matrix ID**.
   Check `.env`. The bot ignores calls from non-authorized users by
   design.

### Phase 4 — Agent rings but call audio is silent

PipeWire virtual devices aren't routed correctly. Run:

```bash
pw-cli list-objects | grep -E '(openclaw_stt|openclaw_tts)'
```

You should see four named nodes. If any are missing, re-run
`bash setup.sh --auto` to recreate them.

## When to stop and ask the human

Stop and ask in plain language whenever:

- A precondition flagged "Human-required" above is missing.
- A decision-point flagged "If unsure: ask" comes up.
- A failure recovery suggests "the human must..."
- You'd need to make a security-relevant choice (TLS cert, password,
  port-forwarding, public exposure) without prior approval.
- A command would consume cloud quota the human hasn't approved
  (ElevenLabs, OpenAI, Brave Search).
- You're about to wipe an existing whisper.cpp / ElevenLabs config
  the human depends on.

## Don'ts

- **Don't** generate Matrix passwords or access tokens. Ask the human.
- **Don't** configure the human's router or firewall (port forwarding
  belongs to the human; you can hand them
  [docs/firewall/](docs/firewall/) instructions).
- **Don't** run `setup-homeserver.sh` without first confirming the
  human has the domain, email, ports, and password choices ready.
- **Don't** use `--no-verify` on git commits or `--force` on git push
  unless explicitly asked.
- **Don't** bind the agent's `:8179` outbound-call API to a public
  interface without the human putting an auth proxy in front.
- **Don't** commit `.env` to git. The `.gitignore` should exclude it;
  verify before any commit.

## Output convention for autonomous reports

When reporting back to a parent agent or the human, use this format:

```
matrix-voip-agent deployment: OK
- topology: <single-host | two-host>
- matrix path: <A bring-your-own | B turnkey>
- voice backend: STT=<qwen|whisper|openai>, TTS=<qwen|elevenlabs>
- GPU host: <ip>  [reachable: <yes|no>]
  - LLM main:    <model-id> on :8000 [<wall ms> for "hi" smoke test]
  - ASR sidecar: <model-id> on :8001 [<wall ms> round-trip]
  - TTS sidecar: <model-id> on :8002 [<wall ms> for 31-char synth]
- matrix-voip-agent host: <hostname>
  - matrix-voip-agent: running [pid <n>, uptime <s>]
  - matrix homeserver: <url>
  - bot: <user-id> [logged in: <yes|no>]
  - smoke call: <greeting heard | failed>
```

If FAIL at any phase, include the failing command and the last 20
lines of the relevant logs (container logs for sidecars, journalctl
for the agent).
