# Fully Offline Voice Stack — setup guide

> **The recommended path for production voice agents.** Pair this Matrix
> WebRTC bridge with three local sidecars (LLM + ASR + TTS) on a single
> GPU host and you get a sub-3-second end-to-end voice turn with **zero
> cloud dependencies** — no ElevenLabs, no OpenAI, no Whisper API.

This guide walks you from "fresh DGX Spark + a Linux box for the agent"
all the way to "I dialed my AI in Element and we had a real conversation
in 2 seconds per turn." Every step is concrete and copy-pasteable.

## What you'll have when you're done

```
                      ┌──────────────────────── DGX Spark (GPU host) ───────────────────────────────┐
                      │                                                                             │
                      │   docker bridge "aeon-stack"                                                │
                      │   ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐          │
                      │   │ qwen36-aeon-xs   │  │ qwen3-asr        │  │ qwen3-tts        │          │
                      │   │ vLLM main:8000   │  │ vLLM ASR:8001    │  │ FastAPI TTS:8002 │          │
                      │   │ Qwen3.6-27B      │  │ Qwen3-ASR-0.6B   │  │ Qwen3-TTS-1.7B   │          │
                      │   └──────────────────┘  └──────────────────┘  └──────────────────┘          │
                      └─────────────────────────────────────┬───────────────────────────────────────┘
                                                            │  LAN (~1 ms)
                      ┌─────────────────────────────────────┼───────────────────────────────────────┐
                      │   matrix-voip-agent host            ▼                                       │
                      │   - matrix-voip-agent (this repo, headless WebRTC bridge)                   │
                      │   - Matrix homeserver (Synapse / Conduit / Dendrite — local or remote)      │
                      │   - PipeWire (audio plumbing)                                               │
                      └─────────────────────────────────────┬───────────────────────────────────────┘
                                                            │
                                                            ▼
                                              Element / nheko / FluffyChat
                                              (any Matrix client = "dial the AI")
```

**Latency budget on Spark, hot path:**

| stage | wall |
|---|---|
| inbound RTP packet → matrix-voip-agent | ~5 ms |
| ASR (1.92 s clip → text) | 120 ms |
| LLM (Qwen3.6-27B chat completion, ~10 toks) | ~480 ms |
| TTS (text → 1.92 s WAV) | ~1.48 s |
| outbound RTP → Matrix client | ~5 ms |
| **End-to-end voice turn** | **~2.1 s** |

## Preconditions

You need:

1. **A GPU host** for the three AI sidecars. NVIDIA DGX Spark (GB10 / sm_121a)
   is the validated target, but any Blackwell consumer GPU works.
   - Docker with the `nvidia` runtime
   - ≥ 110 GB unified RAM available (96 GB LLM + 10 GB ASR + 4 GB TTS + headroom)
   - Outbound HTTPS to `huggingface.co` and `ghcr.io`
2. **A Linux host for matrix-voip-agent.** Can be the same machine as the
   GPU host or a separate one (LAN-connected). PipeWire, Node 22, ffmpeg.
3. **A Matrix homeserver.** Either bring-your-own (Synapse / Conduit /
   Dendrite, with a TURN server configured for WebRTC), or use this repo's
   `setup-homeserver.sh` to spin up a turnkey Dendrite + coturn + Caddy
   stack on the matrix-voip-agent host.
4. **Bot account** on the homeserver with a password or access token.

## Phase 1 — Bring up the three AI sidecars on the GPU host

Run this section ON the GPU host (DGX Spark in the validated reference).

### 1a. Create the shared Docker bridge

```bash
docker network create aeon-stack
```

All three sidecars join this bridge so inter-container hops are loopback-fast.

### 1b. Pull and start the LLM main

This is the recommended pairing — the AEON Ultimate Qwen3.6-27B with NVFP4
quantization and DFlash speculative decoding. **Start this first** because
it's the heaviest container; the others will fit around it.

```bash
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

# Wait for ready (model load + CUDA graph compile takes ~3 min on first boot)
until curl -sf -m 2 http://localhost:8000/health >/dev/null; do sleep 5; done
echo "LLM main ready"
```

Full deploy guide and rationale: https://github.com/AEON-7/Qwen3.6-27B-AEON-Ultimate-Uncensored-DFlash

### 1c. Pull and start the ASR sidecar

```bash
docker run -d --name qwen3-asr \
  --runtime nvidia --network aeon-stack -p 8001:8001 \
  --shm-size=4gb --restart unless-stopped \
  -v ${HOME}/.cache/huggingface:/root/.cache/huggingface \
  -e NVIDIA_VISIBLE_DEVICES=all \
  ghcr.io/aeon-7/qwen3-asr-server:latest

# Wait for ready (~30-90 s on first boot for model load + CUDA graph compile)
until curl -sf -m 2 http://localhost:8001/health >/dev/null; do sleep 5; done
echo "ASR ready"
```

Full doc: https://github.com/AEON-7/qwen3-asr-server

### 1d. Pull and start the TTS sidecar

```bash
docker run -d --name qwen3-tts \
  --runtime nvidia --network aeon-stack -p 8002:8002 \
  --shm-size=4gb --restart unless-stopped \
  -v ${HOME}/.cache/huggingface:/root/.cache/huggingface \
  -e NVIDIA_VISIBLE_DEVICES=all \
  ghcr.io/aeon-7/qwen3-tts-server:latest

# Wait for ready (~10-20 s for model load)
until curl -sf -m 2 http://localhost:8002/health 2>/dev/null | grep -q model_loaded; do sleep 2; done
echo "TTS ready"
```

Full doc: https://github.com/AEON-7/qwen3-tts-server

### 1e. Smoke test all three from the GPU host

```bash
# LLM
curl -s http://localhost:8000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen36-ultimate-xs","messages":[{"role":"user","content":"hi"}],"max_tokens":20}' \
  | head -c 200 && echo

# TTS — synthesize a test WAV
curl -s http://localhost:8002/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3-tts","input":"hello, this is a test","response_format":"wav"}' \
  --output /tmp/smoke.wav
ls -la /tmp/smoke.wav   # should be ~80 KB

# ASR — transcribe the WAV we just made
curl -s -X POST http://localhost:8001/v1/audio/transcriptions \
  -F file=@/tmp/smoke.wav -F model=qwen3-asr -F language=en
# expect: {"text":"hello, this is a test"}
```

If all three pass, your AI stack is operational. Note the GPU host's LAN
IP — you'll need it on the matrix-voip-agent host. We'll call it
`SPARK_HOST` from here on.

## Phase 2 — Bring up matrix-voip-agent on the agent host

Run this section ON the matrix-voip-agent host. It can be the same machine
as the GPU host (the LAN hop becomes loopback) or a separate Linux box.

### 2a. Have a Matrix homeserver ready

If you already have one (Synapse / Conduit / Dendrite with TURN), skip
to step 2b.

If not, this repo bundles a **turnkey homeserver** — Dendrite + coturn +
Caddy + automatic Let's Encrypt + DynDNS — that you can stand up in one
script:

```bash
git clone https://github.com/AEON-7/matrix-voip-agent
cd matrix-voip-agent
bash setup-homeserver.sh
```

Walks you through DuckDNS / your-own-domain, TLS, firewall ports, bot
account creation, and federation `.well-known` setup. See the main README
for the full runbook (Path B section).

### 2b. Install matrix-voip-agent

```bash
git clone https://github.com/AEON-7/matrix-voip-agent   # if you didn't already
cd matrix-voip-agent
bash setup.sh
```

The setup script installs PipeWire, Node 22, ffmpeg, libopus and walks you
through the credential prompts. **For the fully-offline path**, when
prompted, supply the GPU host's IP as the LLM URL and skip the ElevenLabs
prompt — you'll set Qwen-specific env vars manually in step 2c.

### 2c. Configure `.env` for the fully-offline path

Edit `.env` (created by `setup.sh`) and set the following:

```bash
# ── Backend selection — fully offline ─────────────────────────────────────
STT_BACKEND=qwen
TTS_BACKEND=qwen

# ── GPU host (substitute for your DGX Spark / Blackwell host's LAN IP) ──
SPARK_HOST=192.168.1.116

# ── Qwen3-ASR ─────────────────────────────────────────────────────────────
QWEN_ASR_ENDPOINT=http://${SPARK_HOST}:8001/v1
QWEN_ASR_MODEL=qwen3-asr
QWEN_ASR_LANGUAGE=en

# ── Qwen3-TTS ─────────────────────────────────────────────────────────────
QWEN_TTS_ENDPOINT=http://${SPARK_HOST}:8002/v1
QWEN_TTS_MODEL=qwen3-tts
# Free-form voice description — forwarded to qwen-tts as the `instruct` field.
QWEN_TTS_VOICE="A warm, expressive adult voice with natural cadence."
# QWEN_TTS_LANGUAGE=en   # optional, auto-detect if omitted

# ── LLM main (vLLM) ────────────────────────────────────────────────────────
VLLM_BASE_URL=http://${SPARK_HOST}:8000/v1
VLLM_API_KEY=ignored                # any non-empty string works
VLLM_MODEL=qwen36-ultimate-xs       # matches --served-model-name on the LLM container
# VLLM_SYSTEM_PROMPT=...            # optional, sensible default baked in

# ── LLM reasoning knob (default: thinking OFF for fastest convo) ──────────
# Flip on if you want the model to reason about which tool to call (slower
# LLM leg but smarter tool selection). Pair with the filler below so the
# user hears acknowledgement during the reasoning wait.
# LLM_THINK_FOR_TOOLS=true
# LLM_THINKING_FILLER="Checking on that now, give me a moment."
# LLM_THINKING_FILLER_AFTER_MS=700

# ── Disable cloud paths ───────────────────────────────────────────────────
WHISPER_ENABLED=false
# ELEVENLABS_API_KEY=                # leave unset
# OPENAI_API_KEY=                    # leave unset

# ── Matrix (already populated by setup.sh) ────────────────────────────────
MATRIX_HOMESERVER_URL=https://your-matrix-homeserver.example.org
MATRIX_USER_ID=@yourbot:your-matrix-homeserver.example.org
MATRIX_ACCESS_TOKEN=...              # from setup.sh
AUTHORIZED_USERS=@you:your-matrix-homeserver.example.org

# ── PipeWire (defaults are fine; setup.sh creates the virtual devices) ───
# (no changes needed — the setup script already populates these)
```

> Don't bake the IP into config files you'd commit. The convention
> throughout this stack is `${SPARK_HOST}` — populate it from your shell
> env or your deployment tooling per environment.

### 2d. Start the agent and confirm backend selection

```bash
npm start
# or, run it as a systemd user service:
#   cp systemd/matrix-voip-agent.service ~/.config/systemd/user/
#   systemctl --user enable --now matrix-voip-agent.service
#   journalctl --user -u matrix-voip-agent -f
```

Watch the logs for these lines on first call:

```
[voice-pipeline] TTS backend: qwen3-tts (http://192.168.1.116:8002/v1)
[voice-pipeline] Voice pipeline started (STT: qwen, LLM: direct vLLM)
[qwen-asr-http] qwen3-asr endpoint is healthy at http://192.168.1.116:8001
[qwen-tts-http] Synthesized 31 chars in 1480ms → 92204 bytes PCM (24000Hz, 1ch)
```

If you see `Using local whisper.cpp for STT` instead of `Using qwen3-asr-server`,
your `STT_BACKEND` / `QWEN_ASR_ENDPOINT` env vars aren't being picked up —
check that `.env` is in the agent's working directory.

## Phase 3 — Test it

1. Install Element (or any Matrix client) on your phone or desktop.
2. Sign in with one of the Matrix accounts you listed in `AUTHORIZED_USERS`.
3. Start a DM with the bot account.
4. Tap the phone icon to start a voice call.
5. Wait for the bot to auto-answer (~1 s), then talk.
6. The bot transcribes you, thinks, and responds — first audio in ~2.1 s.

You can watch the latency in real time in the agent logs:

```
[qwen-asr-http] Flushing 1840ms of audio (58880 bytes) to qwen3-asr
[qwen-asr-http] qwen3-asr returned in 142ms: "what's the capital of france"
[voice-pipeline] [qwen] Albert said: "what's the capital of france"
[vllm-client] Chat returned 8 tokens in 487ms
[qwen-tts-http] Synthesized 31 chars in 1487ms → 92204 bytes PCM (24000Hz, 1ch)
[voice-pipeline] Turn complete in 2120ms: "The capital of France is Paris..."
```

**~2.1 s end-to-end.** Hang up — the transcript is auto-saved to
`~/matrix-voip-agent/transcripts/call-YYYY-MM-DD_HH-MM-SS.md`.

## Common issues

### `qwen3-asr endpoint did not respond at http://.../health`

The agent can't reach the ASR endpoint. Check:

1. Is `qwen3-asr` running on the GPU host? `docker ps --filter name=qwen3-asr`
2. Is port 8001 reachable from the agent host? `curl http://${SPARK_HOST}:8001/health`
3. Did you set `QWEN_ASR_ENDPOINT` in `.env` (and is it the FULL `/v1` URL)?

### TTS plays back at the wrong pitch / speed

The agent reads the actual sample rate from the WAV header on every
synthesis call (`outputSampleRate`) and passes it to `pw-play -r ...`.
If you're seeing pitch issues, that path is bypassed somehow — confirm
you're on the latest agent code. Don't hardcode 24 kHz on the client side.

### LLM response is slow (>2 s)

The 480 ms LLM number above is for the AEON Ultimate Qwen3.6-27B with
DFlash speculative decoding. If you're using a different LLM, the LLM
leg dominates — check `VLLM_MODEL` and the LLM container's
`--gpu-memory-utilization` and `--max-model-len` settings.

### "No available memory for the cache blocks" on ASR boot

The ASR container ran out of GPU memory, which is tight on Spark when
all three sidecars are co-resident. Bump the ASR's
`--gpu-memory-utilization` from `0.08` to `0.10` (`docker rm -f qwen3-asr`
then re-run with `GPU_MEM=0.10 bash deploy/deploy-asr.sh`). See
[qwen3-asr-server's MODELS.md](https://github.com/AEON-7/qwen3-asr-server/blob/main/docs/MODELS.md#memory-tuning) for the full memory-tuning matrix.

### I want to switch back to ElevenLabs / whisper.cpp temporarily

Single env var change — no code edits:

```bash
# Cloud TTS instead of local Qwen TTS
TTS_BACKEND=elevenlabs
# (also set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID)

# Local CPU STT instead of GPU Qwen ASR
STT_BACKEND=whisper
WHISPER_ENABLED=true
```

Restart the agent (`systemctl --user restart matrix-voip-agent`) and the
new backend is picked up on the next call.

## Going further

- **Pick a different Qwen3-TTS variant** (CustomVoice / Base / 0.6B sizes):
  see [`qwen3-tts-server` MODELS.md](https://github.com/AEON-7/qwen3-tts-server/blob/main/docs/MODELS.md). Set `QWEN_TTS_MODEL` on the GPU host before starting that container.
- **Pick the larger ASR (1.7B, SOTA WER)** when accuracy matters more than
  throughput — see [`qwen3-asr-server` MODELS.md](https://github.com/AEON-7/qwen3-asr-server/blob/main/docs/MODELS.md).
- **Wire OpenClaw or another agent framework** into the LLM hop —
  matrix-voip-agent's `VLLM_BASE_URL` can point at any OpenAI-compatible
  endpoint, including an agent gateway that adds memory / skills /
  tool-routing in front of the raw LLM.
- **Run multiple bots on one stack** — each bot is its own
  matrix-voip-agent instance with its own `MATRIX_USER_ID`; they all share
  the LLM + ASR + TTS sidecars on the GPU host.

## Why this is the recommended path

- **Privacy.** No audio bytes ever leave your network. ASR transcript and
  the LLM hop both stay on your LAN; only Matrix federation packets cross
  the public internet (and those are E2EE-capable).
- **Latency.** ~2.1 s end-to-end vs ~4 s for whisper.cpp + ElevenLabs and
  ~3 s for OpenAI Realtime + ElevenLabs. The LAN hop in place of the
  internet hop saves 100-300 ms per leg.
- **Cost.** Zero recurring spend. ElevenLabs charges per character;
  OpenAI charges per audio second. Local sidecars amortize at $0/min after
  the GPU is paid for.
- **No vendor risk.** Public weights, public images, MIT/Apache code. If
  ElevenLabs deprecates a voice or OpenAI changes their pricing, your
  voice agent doesn't care.
