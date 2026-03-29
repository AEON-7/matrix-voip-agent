#!/usr/bin/env bash
set -euo pipefail

echo "=== matrix-voip-agent setup ==="
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok() { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }

# ── Check system dependencies ─────────────────────────────────
echo "Checking system dependencies..."

MISSING=()

command -v node >/dev/null 2>&1 && ok "Node.js $(node -v)" || { fail "Node.js not found"; MISSING+=(nodejs); }
command -v npm >/dev/null 2>&1 && ok "npm $(npm -v)" || { fail "npm not found"; MISSING+=(npm); }
command -v cmake >/dev/null 2>&1 && ok "cmake" || { fail "cmake not found"; MISSING+=(cmake); }
command -v ffmpeg >/dev/null 2>&1 && ok "ffmpeg" || { fail "ffmpeg not found"; MISSING+=(ffmpeg); }
command -v pw-play >/dev/null 2>&1 && ok "pw-play (PipeWire)" || { fail "pw-play not found"; MISSING+=(pipewire); }
command -v pw-record >/dev/null 2>&1 && ok "pw-record (PipeWire)" || { fail "pw-record not found"; MISSING+=(pipewire); }
command -v curl >/dev/null 2>&1 && ok "curl" || { fail "curl not found"; MISSING+=(curl); }

# Check libopus
if pkg-config --exists opus 2>/dev/null; then
  ok "libopus-dev"
else
  fail "libopus-dev not found"
  MISSING+=(libopus-dev)
fi

if [ ${#MISSING[@]} -gt 0 ]; then
  echo ""
  echo -e "${YELLOW}Missing packages. Install with:${NC}"
  echo "  sudo apt install -y build-essential cmake git curl ffmpeg libopus-dev \\"
  echo "    pipewire pipewire-pulse wireplumber pipewire-audio-client-libraries"
  echo ""
  read -p "Install now? [y/N] " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    sudo apt install -y build-essential cmake git curl ffmpeg libopus-dev \
      pipewire pipewire-pulse wireplumber pipewire-audio-client-libraries
  else
    echo "Skipping. Please install manually before continuing."
  fi
fi

# ── Check PipeWire ────────────────────────────────────────────
echo ""
echo "Checking PipeWire..."

if pactl info 2>/dev/null | grep -q "PipeWire"; then
  ok "PipeWire is running"
else
  fail "PipeWire is not running (or PulseAudio is active instead)"
  echo "  Make sure PipeWire is your audio server."
fi

# Check virtual devices
if pactl list sinks short 2>/dev/null | grep -q "openclaw_tts"; then
  ok "TTS virtual sink exists"
else
  warn "TTS virtual sink not found — see README for PipeWire loopback setup"
fi

if pactl list sinks short 2>/dev/null | grep -q "openclaw_stt"; then
  ok "STT virtual sink exists"
else
  warn "STT virtual sink not found — see README for PipeWire loopback setup"
fi

# ── Check whisper.cpp ─────────────────────────────────────────
echo ""
echo "Checking whisper.cpp..."

WHISPER_DIR="${WHISPER_DIR:-$HOME/whisper.cpp}"

if [ -x "$WHISPER_DIR/build/bin/whisper-server" ]; then
  ok "whisper-server binary found"
else
  warn "whisper-server not found at $WHISPER_DIR/build/bin/whisper-server"
  read -p "Build whisper.cpp now? [y/N] " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    if [ ! -d "$WHISPER_DIR" ]; then
      git clone https://github.com/ggerganov/whisper.cpp.git "$WHISPER_DIR"
    fi
    cd "$WHISPER_DIR"
    cmake -B build -DCMAKE_BUILD_TYPE=Release
    cmake --build build -j$(nproc)
    ok "whisper.cpp built"
    cd - >/dev/null
  fi
fi

# Check for a model
if ls "$WHISPER_DIR"/models/ggml-base.bin >/dev/null 2>&1; then
  ok "whisper base model found"
elif ls "$WHISPER_DIR"/models/ggml-small.bin >/dev/null 2>&1; then
  ok "whisper small model found"
else
  warn "No whisper model found"
  read -p "Download base model (142MB, recommended for voice)? [y/N] " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    cd "$WHISPER_DIR"
    ./models/download-ggml-model.sh base
    ok "base model downloaded"
    cd - >/dev/null
  fi
fi

# ── Install npm dependencies ──────────────────────────────────
echo ""
echo "Installing Node.js dependencies..."
cd "$(dirname "$0")"
npm install
ok "npm dependencies installed"

# ── Build TypeScript ──────────────────────────────────────────
echo ""
echo "Building TypeScript..."
npm run build
ok "Build complete"

# ── Check .env ────────────────────────────────────────────────
echo ""
echo "Checking configuration..."

if [ -f .env ]; then
  ok ".env file exists"

  # Check required vars
  source .env 2>/dev/null || true
  [ -n "${MATRIX_USER_ID:-}" ] && ok "MATRIX_USER_ID set" || warn "MATRIX_USER_ID not set in .env"
  [ -n "${MATRIX_ACCESS_TOKEN:-}" ] && ok "MATRIX_ACCESS_TOKEN set" || warn "MATRIX_ACCESS_TOKEN not set in .env"
  [ -n "${VLLM_BASE_URL:-}" ] && ok "VLLM_BASE_URL set" || warn "VLLM_BASE_URL not set in .env"
  [ -n "${VLLM_API_KEY:-}" ] && ok "VLLM_API_KEY set" || warn "VLLM_API_KEY not set in .env"
  [ -n "${ELEVENLABS_API_KEY:-}" ] && ok "ELEVENLABS_API_KEY set" || warn "ELEVENLABS_API_KEY not set in .env"
  [ -n "${ELEVENLABS_VOICE_ID:-}" ] && ok "ELEVENLABS_VOICE_ID set" || warn "ELEVENLABS_VOICE_ID not set in .env"
else
  warn ".env not found — creating from template"
  cp .env.example .env
  echo "  Edit .env and fill in your credentials, then run: npm start"
fi

echo ""
echo -e "${GREEN}Setup complete!${NC}"
echo ""
echo "Next steps:"
echo "  1. Edit .env with your credentials (if not already done)"
echo "  2. Set up PipeWire loopback devices (see README)"
echo "  3. Run: npm start"
echo "  4. Call the bot from Element"
