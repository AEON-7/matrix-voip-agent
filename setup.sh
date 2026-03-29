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

# Validate required vars
echo ""
echo "  Checking required environment variables..."
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
echo "  Next steps:"
echo ""
if ! grep -q "MATRIX_ACCESS_TOKEN=.\+" .env 2>/dev/null; then
  echo "  1. Generate a Matrix access token (see README)"
  echo "  2. Fill in all credentials in .env"
  echo "  3. Run: npm start"
else
  echo "  Run: npm start"
fi
echo ""
echo "  Or install as a service:"
echo "    cp systemd/matrix-voip-agent.service ~/.config/systemd/user/"
echo "    systemctl --user daemon-reload"
echo "    systemctl --user enable --now matrix-voip-agent.service"
echo ""
