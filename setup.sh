#!/usr/bin/env bash
set -euo pipefail

# Usage: bash setup.sh [--auto]
#   --auto   Install everything without prompting

AUTO=false
[[ "${1:-}" == "--auto" ]] && AUTO=true

echo "=== matrix-voip-agent setup ==="
echo ""

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

ok() { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
step() { echo -e "\n${CYAN}[$1/$TOTAL_STEPS]${NC} $2"; }

ask() {
  if $AUTO; then return 0; fi
  read -p "$1 [y/N] " -n 1 -r; echo
  [[ $REPLY =~ ^[Yy]$ ]]
}

TOTAL_STEPS=7
# Step 7 now includes interactive credential configuration
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WHISPER_DIR="${WHISPER_DIR:-$HOME/whisper.cpp}"
WHISPER_MODEL="${WHISPER_MODEL:-base}"

# ── Step 1: System packages ───────────────────────────────────
step 1 "System packages"

PACKAGES=(
  build-essential cmake git curl ffmpeg pkg-config
  pipewire pipewire-pulse wireplumber
  pipewire-audio-client-libraries
  libopus-dev
)

MISSING=()
for pkg in "${PACKAGES[@]}"; do
  if dpkg -s "$pkg" >/dev/null 2>&1; then
    ok "$pkg"
  else
    fail "$pkg not installed"
    MISSING+=("$pkg")
  fi
done

if [ ${#MISSING[@]} -gt 0 ]; then
  echo ""
  echo -e "  Missing: ${MISSING[*]}"
  if ask "  Install missing packages?"; then
    sudo apt update -qq
    sudo apt install -y "${MISSING[@]}"
    ok "All packages installed"
  else
    echo "  Skipping. Install manually: sudo apt install -y ${MISSING[*]}"
  fi
else
  ok "All system packages present"
fi

# ── Step 2: Node.js ──────────────────────────────────────────
step 2 "Node.js"

if command -v node >/dev/null 2>&1; then
  NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VER" -ge 20 ]; then
    ok "Node.js $(node -v)"
  else
    fail "Node.js $(node -v) is too old (need >= 20)"
    echo "  Install Node.js 22: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs"
  fi
else
  fail "Node.js not found"
  if ask "  Install Node.js 22?"; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt install -y nodejs
    ok "Node.js $(node -v) installed"
  else
    echo "  Install manually: https://nodejs.org/"
  fi
fi

# ── Step 3: PipeWire virtual audio devices ────────────────────
step 3 "PipeWire virtual audio devices"

PIPEWIRE_CONF_DIR="$HOME/.config/pipewire/pipewire.conf.d"
mkdir -p "$PIPEWIRE_CONF_DIR"

TTS_CONF="$PIPEWIRE_CONF_DIR/voip-tts-sink.conf"
STT_CONF="$PIPEWIRE_CONF_DIR/voip-stt-source.conf"

NEED_PW_RESTART=false

if [ -f "$TTS_CONF" ]; then
  ok "TTS loopback config exists"
else
  warn "TTS loopback config missing"
  cat > "$TTS_CONF" << 'PWEOF'
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
PWEOF
  ok "Created $TTS_CONF"
  NEED_PW_RESTART=true
fi

if [ -f "$STT_CONF" ]; then
  ok "STT loopback config exists"
else
  warn "STT loopback config missing"
  cat > "$STT_CONF" << 'PWEOF'
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
PWEOF
  ok "Created $STT_CONF"
  NEED_PW_RESTART=true
fi

if $NEED_PW_RESTART; then
  systemctl --user restart pipewire.service pipewire-pulse.service 2>/dev/null || true
  sleep 2
  ok "PipeWire restarted"
fi

# Verify devices
if pactl list sinks short 2>/dev/null | grep -q "openclaw_tts"; then
  ok "TTS virtual sink active"
else
  warn "TTS virtual sink not detected (PipeWire may need a restart)"
fi

if pactl list sinks short 2>/dev/null | grep -q "openclaw_stt"; then
  ok "STT virtual sink active"
else
  warn "STT virtual sink not detected (PipeWire may need a restart)"
fi

# ── Step 4: whisper.cpp ──────────────────────────────────────
step 4 "whisper.cpp (local speech-to-text)"

if [ -x "$WHISPER_DIR/build/bin/whisper-server" ]; then
  ok "whisper-server binary found at $WHISPER_DIR"
else
  warn "whisper-server not found"
  if ask "  Clone, build whisper.cpp, and download $WHISPER_MODEL model?"; then
    if [ ! -d "$WHISPER_DIR" ]; then
      git clone https://github.com/ggerganov/whisper.cpp.git "$WHISPER_DIR"
    fi
    cd "$WHISPER_DIR"
    cmake -B build -DCMAKE_BUILD_TYPE=Release
    cmake --build build -j"$(nproc)"
    ok "whisper.cpp built"
    cd "$SCRIPT_DIR"
  fi
fi

# Check model
MODEL_FILE="$WHISPER_DIR/models/ggml-${WHISPER_MODEL}.bin"
if [ -f "$MODEL_FILE" ]; then
  ok "whisper $WHISPER_MODEL model found ($(du -h "$MODEL_FILE" | cut -f1))"
else
  warn "whisper $WHISPER_MODEL model not found"
  if ask "  Download $WHISPER_MODEL model?"; then
    cd "$WHISPER_DIR"
    ./models/download-ggml-model.sh "$WHISPER_MODEL"
    ok "$WHISPER_MODEL model downloaded"
    cd "$SCRIPT_DIR"
  fi
fi

# ── Step 5: npm install ──────────────────────────────────────
step 5 "Node.js dependencies"

cd "$SCRIPT_DIR"
npm install --loglevel=warn
ok "npm dependencies installed"

# ── Step 6: Build TypeScript ─────────────────────────────────
step 6 "Build"

npm run build
ok "TypeScript build complete"

# ── Step 7: Configuration ────────────────────────────────────
step 7 "Configuration"

if [ -f .env ]; then
  ok ".env file exists"
else
  cp .env.example .env
  ok "Created .env from template"
fi

source .env 2>/dev/null || true

# Interactive credential setup (skip in --auto mode if already configured)
needs_config() {
  local val="${!1:-}"
  [ -z "$val" ] || [[ "$val" == YOUR_* ]] || [[ "$val" == your-* ]]
}

if ! $AUTO; then
  echo ""
  echo -e "  ${CYAN}Configure your credentials interactively?${NC}"
  echo "  (You can always edit .env manually later)"
  echo ""

  if ask "  Configure now?"; then

    # ── Matrix ──
    echo ""
    echo -e "  ${CYAN}── Matrix Homeserver ──${NC}"
    echo ""

    if needs_config MATRIX_HOMESERVER_URL; then
      read -p "  Matrix homeserver URL [http://127.0.0.1:8008]: " HS_URL
      HS_URL="${HS_URL:-http://127.0.0.1:8008}"
      sed -i "s|^MATRIX_HOMESERVER_URL=.*|MATRIX_HOMESERVER_URL=${HS_URL}|" .env
      ok "Homeserver: $HS_URL"
    else
      ok "Homeserver already set: $MATRIX_HOMESERVER_URL"
      HS_URL="$MATRIX_HOMESERVER_URL"
    fi

    if needs_config MATRIX_USER_ID; then
      read -p "  Bot Matrix user ID (e.g. @mybot:example.com): " BOT_USER
      if [ -n "$BOT_USER" ]; then
        sed -i "s|^MATRIX_USER_ID=.*|MATRIX_USER_ID=${BOT_USER}|" .env
        ok "User ID: $BOT_USER"
      fi
    else
      ok "User ID already set: $MATRIX_USER_ID"
      BOT_USER="$MATRIX_USER_ID"
    fi

    if needs_config MATRIX_ACCESS_TOKEN; then
      echo ""
      echo "  To generate an access token, you need the bot account's password."
      read -sp "  Bot account password (leave blank to skip): " BOT_PASS
      echo ""
      if [ -n "$BOT_PASS" ]; then
        USERNAME=$(echo "$BOT_USER" | sed 's/@\(.*\):.*/\1/')
        TOKEN_RESP=$(curl -sf -X POST "${HS_URL}/_matrix/client/v3/login" \
          -H 'Content-Type: application/json' \
          -d "{
            \"type\": \"m.login.password\",
            \"identifier\": {\"type\": \"m.id.user\", \"user\": \"${USERNAME}\"},
            \"password\": \"${BOT_PASS}\",
            \"device_id\": \"VOIP_AGENT\",
            \"initial_device_display_name\": \"VoIP Agent\"
          }" 2>/dev/null || echo "")

        if echo "$TOKEN_RESP" | python3 -c "import sys,json; json.load(sys.stdin)['access_token']" >/dev/null 2>&1; then
          ACCESS_TOKEN=$(echo "$TOKEN_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")
          sed -i "s|^MATRIX_ACCESS_TOKEN=.*|MATRIX_ACCESS_TOKEN=${ACCESS_TOKEN}|" .env
          ok "Access token generated and saved"
        else
          warn "Login failed — check homeserver URL and password"
          echo "  You can set MATRIX_ACCESS_TOKEN manually in .env"
        fi
      else
        warn "Skipped — set MATRIX_ACCESS_TOKEN in .env manually"
      fi
    else
      ok "Access token already set"
    fi

    if needs_config AUTHORIZED_USERS; then
      read -p "  Your Matrix user ID (who can call the bot, e.g. @you:example.com): " AUTH_USER
      if [ -n "$AUTH_USER" ]; then
        sed -i "s|^AUTHORIZED_USERS=.*|AUTHORIZED_USERS=${AUTH_USER}|" .env
        ok "Authorized user: $AUTH_USER"
      fi
    else
      ok "Authorized users already set: $AUTHORIZED_USERS"
    fi

    # ── LLM ──
    echo ""
    echo -e "  ${CYAN}── LLM Server (OpenAI-compatible API) ──${NC}"
    echo ""

    if needs_config VLLM_BASE_URL; then
      read -p "  LLM API base URL (e.g. http://localhost:8000/v1 or https://api.openai.com/v1): " LLM_URL
      if [ -n "$LLM_URL" ]; then
        sed -i "s|^VLLM_BASE_URL=.*|VLLM_BASE_URL=${LLM_URL}|" .env
        ok "LLM URL: $LLM_URL"
      fi
    else
      ok "LLM URL already set: $VLLM_BASE_URL"
    fi

    if needs_config VLLM_API_KEY; then
      read -sp "  LLM API key: " LLM_KEY
      echo ""
      if [ -n "$LLM_KEY" ]; then
        sed -i "s|^VLLM_API_KEY=.*|VLLM_API_KEY=${LLM_KEY}|" .env
        ok "LLM API key saved"
      fi
    else
      ok "LLM API key already set"
    fi

    if needs_config VLLM_MODEL; then
      read -p "  LLM model name (e.g. gpt-4o, llama-3, qwen-72b): " LLM_MODEL
      if [ -n "$LLM_MODEL" ]; then
        sed -i "s|^VLLM_MODEL=.*|VLLM_MODEL=${LLM_MODEL}|" .env
        ok "LLM model: $LLM_MODEL"
      fi
    else
      ok "LLM model already set: $VLLM_MODEL"
    fi

    # ── ElevenLabs ──
    echo ""
    echo -e "  ${CYAN}── ElevenLabs TTS ──${NC}"
    echo ""

    if needs_config ELEVENLABS_API_KEY; then
      read -sp "  ElevenLabs API key: " EL_KEY
      echo ""
      if [ -n "$EL_KEY" ]; then
        sed -i "s|^ELEVENLABS_API_KEY=.*|ELEVENLABS_API_KEY=${EL_KEY}|" .env
        ok "ElevenLabs API key saved"
      fi
    else
      ok "ElevenLabs API key already set"
    fi

    if needs_config ELEVENLABS_VOICE_ID; then
      read -p "  ElevenLabs voice ID: " EL_VOICE
      if [ -n "$EL_VOICE" ]; then
        sed -i "s|^ELEVENLABS_VOICE_ID=.*|ELEVENLABS_VOICE_ID=${EL_VOICE}|" .env
        ok "ElevenLabs voice ID: $EL_VOICE"
      fi
    else
      ok "ElevenLabs voice ID already set: $ELEVENLABS_VOICE_ID"
    fi

    # ── Optional: API token ──
    echo ""
    echo -e "  ${CYAN}── Outbound Call API (optional) ──${NC}"
    echo ""

    if needs_config API_TOKEN; then
      GENERATED_TOKEN=$(openssl rand -hex 24 2>/dev/null || python3 -c "import secrets; print(secrets.token_hex(24))" 2>/dev/null || echo "")
      if [ -n "$GENERATED_TOKEN" ]; then
        sed -i "s|^API_TOKEN=.*|API_TOKEN=${GENERATED_TOKEN}|" .env
        ok "API token generated: ${GENERATED_TOKEN:0:8}..."
      fi
    else
      ok "API token already set"
    fi

  fi
fi

# ── Final validation ──
echo ""
echo "  Checking all required variables..."
source .env 2>/dev/null || true

check_var() {
  local name="$1"
  local val="${!name:-}"
  if [ -n "$val" ] && [ "$val" != "YOUR_"* ] && [ "$val" != "your-"* ]; then
    ok "$name"
  else
    warn "$name — not set (edit .env)"
  fi
}

check_var MATRIX_USER_ID
check_var MATRIX_ACCESS_TOKEN
check_var AUTHORIZED_USERS
check_var VLLM_BASE_URL
check_var VLLM_API_KEY
check_var VLLM_MODEL
check_var ELEVENLABS_API_KEY
check_var ELEVENLABS_VOICE_ID

# ── Done ─────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo -e "${GREEN}  Setup complete!${NC}"
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo ""

# Count missing vars
source .env 2>/dev/null || true
MISSING_VARS=0
for var in MATRIX_USER_ID MATRIX_ACCESS_TOKEN VLLM_BASE_URL VLLM_API_KEY VLLM_MODEL ELEVENLABS_API_KEY ELEVENLABS_VOICE_ID; do
  val="${!var:-}"
  if [ -z "$val" ] || [[ "$val" == YOUR_* ]] || [[ "$val" == your-* ]]; then
    MISSING_VARS=$((MISSING_VARS + 1))
  fi
done

if [ "$MISSING_VARS" -gt 0 ]; then
  echo "  $MISSING_VARS required variable(s) still need to be set."
  echo "  Edit .env: nano .env"
  echo ""
fi

echo "  Start the agent:"
echo "    npm start"
echo ""
echo "  Or install as a systemd service:"
echo "    cp systemd/matrix-voip-agent.service ~/.config/systemd/user/"
echo "    systemctl --user daemon-reload"
echo "    systemctl --user enable --now matrix-voip-agent.service"
echo ""
