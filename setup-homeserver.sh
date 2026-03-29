#!/usr/bin/env bash
set -euo pipefail

# ══════════════════════════════════════════════════════════════
#  Turnkey Matrix Homeserver Setup
#  Sets up: Dendrite + PostgreSQL + Caddy + coturn + DynDNS
#  All in Docker, with automatic TLS via Let's Encrypt.
# ══════════════════════════════════════════════════════════════

echo "══════════════════════════════════════════════════════════"
echo "  Turnkey Matrix Homeserver Setup"
echo "  Dendrite + Caddy + coturn + DynDNS + Let's Encrypt"
echo "══════════════════════════════════════════════════════════"
echo ""

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

ok() { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
step() { echo -e "\n${CYAN}[$1/$TOTAL_STEPS]${NC} $2\n"; }

TOTAL_STEPS=8
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="$HOME/matrix-server"

# ── Step 1: Docker ────────────────────────────────────────────
step 1 "Docker"

if command -v docker >/dev/null 2>&1; then
  ok "Docker $(docker --version | grep -oP '\d+\.\d+\.\d+')"
else
  echo "  Docker is required for the homeserver deployment."
  read -p "  Install Docker? [y/N] " -n 1 -r; echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    curl -fsSL https://get.docker.com | sh
    sudo usermod -aG docker "$USER"
    ok "Docker installed (you may need to log out and back in for group permissions)"
  else
    fail "Docker is required. Install manually: https://docs.docker.com/engine/install/"
    exit 1
  fi
fi

if docker compose version >/dev/null 2>&1; then
  ok "Docker Compose available"
else
  fail "Docker Compose not found. Install: sudo apt install docker-compose-plugin"
  exit 1
fi

# ── Step 2: Domain / Dynamic DNS ──────────────────────────────
step 2 "Domain and Dynamic DNS"

echo "  How do you want to reach your Matrix server?"
echo ""
echo "    1) DuckDNS    — Free dynamic DNS (recommended)"
echo "    2) No-IP      — Free dynamic DNS"
echo "    3) FreeDNS    — Free dynamic DNS (afraid.org)"
echo "    4) Custom domain — I have my own domain with DNS already configured"
echo ""
read -p "  Choose [1-4]: " DNS_CHOICE

case "$DNS_CHOICE" in
  1)
    echo ""
    echo "  Go to https://www.duckdns.org and:"
    echo "    1. Sign in (use GitHub, Google, etc.)"
    echo "    2. Create a subdomain (e.g., 'mymatrix')"
    echo "    3. Copy your token from the top of the page"
    echo ""
    read -p "  DuckDNS subdomain (just the name, not .duckdns.org): " DUCKDNS_SUB
    read -p "  DuckDNS token: " DUCKDNS_TOKEN
    DOMAIN="${DUCKDNS_SUB}.duckdns.org"
    DNS_PROVIDER="duckdns"
    ok "Domain: $DOMAIN"
    ;;
  2)
    echo ""
    echo "  Go to https://www.noip.com and create a free hostname."
    echo ""
    read -p "  No-IP hostname (e.g., mymatrix.ddns.net): " DOMAIN
    read -p "  No-IP email: " NOIP_EMAIL
    read -sp "  No-IP password: " NOIP_PASS; echo
    DNS_PROVIDER="noip"
    ok "Domain: $DOMAIN"
    ;;
  3)
    echo ""
    echo "  Go to https://freedns.afraid.org and create a subdomain."
    echo "  Then go to 'Dynamic DNS' and copy your update URL."
    echo ""
    read -p "  FreeDNS update URL: " FREEDNS_URL
    read -p "  Your full domain (e.g., mymatrix.mooo.com): " DOMAIN
    DNS_PROVIDER="freedns"
    ok "Domain: $DOMAIN"
    ;;
  4)
    read -p "  Your domain (e.g., matrix.example.com): " DOMAIN
    DNS_PROVIDER="custom"
    echo ""
    echo "  Make sure your domain's A record points to this server's public IP."
    echo "  Public IP: $(curl -sf https://api.ipify.org || echo 'could not detect')"
    echo ""
    ok "Domain: $DOMAIN"
    ;;
  *)
    fail "Invalid choice"
    exit 1
    ;;
esac

# ── Step 3: Email for Let's Encrypt ──────────────────────────
step 3 "TLS Certificates (Let's Encrypt)"

read -p "  Email address for Let's Encrypt (for certificate expiry warnings): " ACME_EMAIL
ok "Email: $ACME_EMAIL"

# ── Step 4: Accounts ─────────────────────────────────────────
step 4 "Matrix accounts"

read -p "  Admin username (e.g., admin): " ADMIN_USER
read -sp "  Admin password: " ADMIN_PASS; echo
echo ""
read -p "  Bot username (e.g., celina): " BOT_USER
read -sp "  Bot password: " BOT_PASS; echo
ok "Admin: @${ADMIN_USER}:${DOMAIN}"
ok "Bot: @${BOT_USER}:${DOMAIN}"

# ── Step 5: Generate secrets and create deployment ────────────
step 5 "Creating deployment files"

mkdir -p "$DEPLOY_DIR"/{config,caddy/certs,coturn,dyndns}

# Generate secrets
TURN_SECRET=$(openssl rand -hex 32)
DB_PASS=$(openssl rand -hex 16)

# Generate Dendrite signing key
openssl genpkey -algorithm ed25519 -out "$DEPLOY_DIR/config/matrix_key.pem" 2>/dev/null

# ── Dendrite config ──
cat > "$DEPLOY_DIR/config/dendrite.yaml" << DENDEOF
version: 2

global:
  server_name: $DOMAIN
  private_key: matrix_key.pem
  key_validity_period: 168h0m0s

  database:
    connection_string: postgresql://dendrite:${DB_PASS}@postgres/dendrite?sslmode=disable
    max_open_conns: 90
    max_idle_conns: 5
    conn_max_lifetime: -1

  cache:
    max_size_estimated: 512mb
    max_age: 1h

  well_known_server_name: "${DOMAIN}:443"
  well_known_client_name: "https://${DOMAIN}"

  trusted_third_party_id_servers: []
  disable_federation: false

  presence:
    enable_inbound: true
    enable_outbound: true

  report_stats:
    enabled: false

  turn:
    turn_uris:
      - "turn:${DOMAIN}:3478?transport=udp"
      - "turn:${DOMAIN}:3478?transport=tcp"
    turn_shared_secret: "${TURN_SECRET}"
    turn_user_lifetime: "1h"

client_api:
  registration_disabled: true
  guests_disabled: true
  registration_shared_secret: "setup-$(openssl rand -hex 16)"
  enable_registration_captcha: false

  rate_limiting:
    enabled: true
    threshold: 50
    cooloff_ms: 500

federation_api:
  send_max_retries: 16
  disable_tls_validation: false

media_api:
  max_file_size_bytes: 52428800
  max_thumbnail_generators: 10

sync_api:
  real_ip_header: X-Real-IP
DENDEOF
ok "Dendrite config generated"

# ── Caddy config ──
cat > "$DEPLOY_DIR/caddy/Caddyfile" << CADDYEOF
{
    email $ACME_EMAIL
}

${DOMAIN}:443 {
    header /.well-known/matrix/* {
        Content-Type application/json
        Access-Control-Allow-Origin *
        Cache-Control "no-cache, no-store, must-revalidate"
    }

    respond /.well-known/matrix/server \`{"m.server":"${DOMAIN}:443"}\`
    respond /.well-known/matrix/client \`{"m.homeserver":{"base_url":"https://${DOMAIN}"}}\`

    reverse_proxy /_matrix/* dendrite:8008 {
        header_up X-Forwarded-For {remote_host}
        header_up X-Real-IP {remote_host}
    }
    reverse_proxy /_synapse/* dendrite:8008 {
        header_up X-Forwarded-For {remote_host}
        header_up X-Real-IP {remote_host}
    }
}

${DOMAIN}:8448 {
    reverse_proxy /_matrix/* dendrite:8008 {
        header_up X-Forwarded-For {remote_host}
        header_up X-Real-IP {remote_host}
    }
}
CADDYEOF
ok "Caddy config generated (automatic Let's Encrypt TLS)"

# ── coturn config ──
PUBLIC_IP=$(curl -sf https://api.ipify.org || echo "0.0.0.0")

cat > "$DEPLOY_DIR/coturn/turnserver.conf" << TURNEOF
listening-port=3478
tls-listening-port=5349
fingerprint
use-auth-secret
static-auth-secret=${TURN_SECRET}
realm=${DOMAIN}
total-quota=100
stale-nonce=600
cert=/etc/ssl/certs/ssl-cert-snakeoil.pem
pkey=/etc/ssl/private/ssl-cert-snakeoil.key
no-multicast-peers
no-cli
no-tlsv1
no-tlsv1_1
external-ip=${PUBLIC_IP}
TURNEOF
ok "coturn config generated (TURN secret shared with Dendrite)"

# ── Docker Compose ──
cat > "$DEPLOY_DIR/docker-compose.yml" << COMPEOF
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: dendrite
      POSTGRES_PASSWORD: ${DB_PASS}
      POSTGRES_DB: dendrite
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U dendrite"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - internal

  dendrite:
    image: matrixdotorg/dendrite-monolith:latest
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    volumes:
      - ./config:/etc/dendrite
      - dendrite-media:/var/dendrite/media
      - dendrite-jetstream:/var/dendrite/jetstream
    ports:
      - "127.0.0.1:8008:8008"
    networks:
      - internal

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    depends_on:
      - dendrite
    ports:
      - "443:443"
      - "8448:8448"
      - "80:80"
    volumes:
      - ./caddy/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    networks:
      - internal

  coturn:
    image: coturn/coturn:latest
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./coturn/turnserver.conf:/etc/turnserver.conf:ro
    command: ["-c", "/etc/turnserver.conf"]

volumes:
  postgres-data:
  dendrite-media:
  dendrite-jetstream:
  caddy-data:
  caddy-config:

networks:
  internal:
COMPEOF
ok "Docker Compose generated"

# ── DynDNS updater ──
case "$DNS_PROVIDER" in
  duckdns)
    cat > "$DEPLOY_DIR/dyndns/update.sh" << DNSEOF
#!/bin/bash
curl -sf "https://www.duckdns.org/update?domains=${DUCKDNS_SUB}&token=${DUCKDNS_TOKEN}&ip=" >/dev/null
DNSEOF
    ;;
  noip)
    cat > "$DEPLOY_DIR/dyndns/update.sh" << DNSEOF
#!/bin/bash
curl -sf --user "${NOIP_EMAIL}:${NOIP_PASS}" "https://dynupdate.no-ip.com/nic/update?hostname=${DOMAIN}" >/dev/null
DNSEOF
    ;;
  freedns)
    cat > "$DEPLOY_DIR/dyndns/update.sh" << DNSEOF
#!/bin/bash
curl -sf "${FREEDNS_URL}" >/dev/null
DNSEOF
    ;;
  custom)
    cat > "$DEPLOY_DIR/dyndns/update.sh" << 'DNSEOF'
#!/bin/bash
# Custom domain — no dynamic DNS needed.
# If you need dynamic DNS, replace this with your provider's update command.
exit 0
DNSEOF
    ;;
esac
chmod +x "$DEPLOY_DIR/dyndns/update.sh"
ok "DynDNS updater created ($DNS_PROVIDER)"

# ── Step 6: Start services ───────────────────────────────────
step 6 "Starting services"

cd "$DEPLOY_DIR"

# Update DNS first
echo "  Updating DNS..."
bash dyndns/update.sh && ok "DNS updated" || warn "DNS update failed (may work anyway)"

echo "  Starting Docker containers..."
docker compose up -d
sleep 5

# Wait for Dendrite
echo "  Waiting for Dendrite to start..."
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:8008/_matrix/client/versions >/dev/null 2>&1; then
    ok "Dendrite is running"
    break
  fi
  sleep 2
  if [ "$i" -eq 30 ]; then
    fail "Dendrite did not start in 60 seconds"
    echo "  Check logs: docker compose logs dendrite"
    exit 1
  fi
done

# ── Step 7: Create accounts ──────────────────────────────────
step 7 "Creating accounts"

# Get the registration shared secret from config
REG_SECRET=$(grep "registration_shared_secret" "$DEPLOY_DIR/config/dendrite.yaml" | awk -F'"' '{print $2}')

# Create admin account
docker exec "$(docker compose ps -q dendrite)" /usr/bin/create-account \
  -username "$ADMIN_USER" -password "$ADMIN_PASS" -admin \
  -url http://localhost:8008 2>/dev/null && ok "Admin account: @${ADMIN_USER}:${DOMAIN}" || warn "Admin account may already exist"

# Create bot account
docker exec "$(docker compose ps -q dendrite)" /usr/bin/create-account \
  -username "$BOT_USER" -password "$BOT_PASS" \
  -url http://localhost:8008 2>/dev/null && ok "Bot account: @${BOT_USER}:${DOMAIN}" || warn "Bot account may already exist"

# Generate bot access token
BOT_TOKEN_RESP=$(curl -sf -X POST "http://127.0.0.1:8008/_matrix/client/v3/login" \
  -H 'Content-Type: application/json' \
  -d "{
    \"type\": \"m.login.password\",
    \"identifier\": {\"type\": \"m.id.user\", \"user\": \"${BOT_USER}\"},
    \"password\": \"${BOT_PASS}\",
    \"device_id\": \"VOIP_AGENT\",
    \"initial_device_display_name\": \"VoIP Agent\"
  }" 2>/dev/null || echo "")

BOT_TOKEN=""
if echo "$BOT_TOKEN_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])" >/dev/null 2>&1; then
  BOT_TOKEN=$(echo "$BOT_TOKEN_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")
  ok "Bot access token generated"
else
  warn "Could not generate bot token — you'll need to do this manually"
fi

# ── Step 8: DynDNS cron + firewall ───────────────────────────
step 8 "DynDNS cron and firewall"

# Install cron job for DynDNS updates
CRON_CMD="*/5 * * * * ${DEPLOY_DIR}/dyndns/update.sh >/dev/null 2>&1"
(crontab -l 2>/dev/null | grep -v "dyndns/update.sh"; echo "$CRON_CMD") | crontab -
ok "DynDNS cron installed (every 5 minutes)"

# Configure firewall if ufw is available
if command -v ufw >/dev/null 2>&1; then
  echo "  Configuring firewall (ufw)..."
  sudo ufw allow 443/tcp comment "HTTPS (Matrix)" 2>/dev/null || true
  sudo ufw allow 8448/tcp comment "Matrix federation" 2>/dev/null || true
  sudo ufw allow 3478/tcp comment "TURN TCP" 2>/dev/null || true
  sudo ufw allow 3478/udp comment "TURN UDP" 2>/dev/null || true
  sudo ufw allow 5349/tcp comment "TURNS TLS" 2>/dev/null || true
  sudo ufw allow 49152:65535/udp comment "TURN relay" 2>/dev/null || true
  ok "Firewall rules added"
else
  warn "ufw not found — make sure ports 443, 3478, 5349, 8448 are open"
fi

# ── Write config for voice agent ──────────────────────────────
# Pre-populate the voice agent .env if it exists
VOIP_ENV="$SCRIPT_DIR/.env"
if [ -f "$VOIP_ENV" ] || [ -f "$SCRIPT_DIR/.env.example" ]; then
  if [ ! -f "$VOIP_ENV" ] && [ -f "$SCRIPT_DIR/.env.example" ]; then
    cp "$SCRIPT_DIR/.env.example" "$VOIP_ENV"
  fi
  if [ -f "$VOIP_ENV" ]; then
    sed -i "s|^MATRIX_HOMESERVER_URL=.*|MATRIX_HOMESERVER_URL=http://127.0.0.1:8008|" "$VOIP_ENV"
    sed -i "s|^MATRIX_USER_ID=.*|MATRIX_USER_ID=@${BOT_USER}:${DOMAIN}|" "$VOIP_ENV"
    if [ -n "$BOT_TOKEN" ]; then
      sed -i "s|^MATRIX_ACCESS_TOKEN=.*|MATRIX_ACCESS_TOKEN=${BOT_TOKEN}|" "$VOIP_ENV"
    fi
    sed -i "s|^AUTHORIZED_USERS=.*|AUTHORIZED_USERS=@${ADMIN_USER}:${DOMAIN}|" "$VOIP_ENV"
    ok "Voice agent .env pre-configured with Matrix credentials"
  fi
fi

# ── Done ──────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Matrix homeserver is running!${NC}"
echo -e "${GREEN}══════════════════════════════════════════════════════════${NC}"
echo ""
echo "  Server:     https://${DOMAIN}"
echo "  Admin:      @${ADMIN_USER}:${DOMAIN}"
echo "  Bot:        @${BOT_USER}:${DOMAIN}"
echo "  Deployment: ${DEPLOY_DIR}"
echo ""
echo "  Test federation:"
echo "    curl https://${DOMAIN}/.well-known/matrix/server"
echo ""
echo "  Test client API:"
echo "    curl https://${DOMAIN}/_matrix/client/versions"
echo ""
echo "  Sign in with Element:"
echo "    1. Open Element (app.element.io or mobile app)"
echo "    2. Sign in → Change homeserver → https://${DOMAIN}"
echo "    3. Username: ${ADMIN_USER}  Password: (what you entered)"
echo ""
if [ -f "$VOIP_ENV" ]; then
  echo "  Next: set up the voice agent:"
  echo "    bash setup.sh"
  echo ""
fi
echo "  Server management:"
echo "    cd ${DEPLOY_DIR}"
echo "    docker compose logs -f          # view logs"
echo "    docker compose restart           # restart all"
echo "    docker compose down              # stop all"
echo "    docker compose up -d             # start all"
echo ""
