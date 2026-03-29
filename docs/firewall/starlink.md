# Starlink — Port Forwarding Guide

Works for: **All Starlink hardware** (Standard, High Performance, Mini, flat/round dish).

> **Disclaimer:** This guide is provided as a helpful reference. You assume all responsibility for securing your network and implementing these rules correctly. The authors of matrix-voip-agent are not liable for any misconfigurations or security issues.

## Important: Starlink and CGNAT

Starlink uses **Carrier-Grade NAT (CGNAT)** by default, which means:
- You do **NOT** have a public IP address
- Port forwarding is **impossible** through CGNAT
- Incoming connections from the internet cannot reach your server

### Solutions

#### Option 1: Request a Public IP (Recommended)

Starlink now offers **public IPv4 addresses** in some regions:
1. Go to your Starlink account at `https://www.starlink.com/account`
2. Look for **Public IP** or **Portability** options
3. If available, enable it (may cost extra)

With a public IP, use the Starlink router's port forwarding or put it in **bypass mode** and use your own router.

#### Option 2: Use IPv6 (Recommended — Free, Public, Essentially Static)

Starlink assigns a **public IPv6 prefix** to every customer — no extra cost, no CGNAT. IPv6 addresses are globally routable, meaning incoming connections work without any port forwarding on the Starlink side. The prefix rarely changes, making it essentially static.

**Step 1: Enable IPv6 on your server**

Most modern Linux distributions have IPv6 enabled by default. Verify:

```bash
# Check if you have a public IPv6 address (starts with 2xxx:)
ip -6 addr show scope global
```

If you see an address starting with `2` (e.g., `2605:59c8:...`), you have a public IPv6 address. If not, ensure IPv6 is enabled:

```bash
# Check sysctl
sudo sysctl net.ipv6.conf.all.disable_ipv6
# Should be 0. If it's 1, enable it:
sudo sysctl -w net.ipv6.conf.all.disable_ipv6=0
sudo sysctl -w net.ipv6.conf.default.disable_ipv6=0
# Make persistent:
echo "net.ipv6.conf.all.disable_ipv6 = 0" | sudo tee -a /etc/sysctl.conf
```

**Step 2: Configure your firewall for IPv6**

If using `ufw`:
```bash
sudo ufw allow 443/tcp comment "HTTPS Matrix"
sudo ufw allow 8448/tcp comment "Matrix Federation"
sudo ufw allow 3478 comment "TURN STUN"
sudo ufw allow 5349/tcp comment "TURNS TLS"
sudo ufw allow 49152:65535/udp comment "TURN Relay"
```

`ufw` applies rules to both IPv4 and IPv6 by default.

If using `ip6tables` directly:
```bash
sudo ip6tables -A INPUT -p tcp --dport 443 -j ACCEPT
sudo ip6tables -A INPUT -p tcp --dport 8448 -j ACCEPT
sudo ip6tables -A INPUT -p tcp --dport 3478 -j ACCEPT
sudo ip6tables -A INPUT -p udp --dport 3478 -j ACCEPT
sudo ip6tables -A INPUT -p tcp --dport 5349 -j ACCEPT
sudo ip6tables -A INPUT -p udp --dport 49152:65535 -j ACCEPT
```

**Step 3: Configure DNS with your IPv6 address**

Set an **AAAA record** (not an A record) for your domain pointing to your server's IPv6 address:

```bash
# Get your public IPv6 address
ip -6 addr show scope global | grep inet6 | awk '{print $2}' | cut -d/ -f1 | head -1
```

At your DNS provider, create:
- **AAAA record**: `matrix.yourdomain.com` → `2605:59c8:xxxx:xxxx::1` (your IPv6)

If using DuckDNS, update with IPv6:
```bash
curl "https://www.duckdns.org/update?domains=YOUR_SUB&token=YOUR_TOKEN&ipv6=YOUR_IPV6"
```

**Step 4: Configure coturn for IPv6**

Add to your `turnserver.conf`:
```
listening-ip=::
relay-ip=YOUR_IPV6_ADDRESS
```

**Step 5: Configure Dendrite TURN URIs with IPv6**

In `dendrite.yaml`, use your domain (which has the AAAA record) rather than an IP:
```yaml
turn:
  turn_uris:
    - "turn:matrix.yourdomain.com:3478?transport=udp"
    - "turn:matrix.yourdomain.com:3478?transport=tcp"
```

**Step 6: Verify IPv6 connectivity from outside**

From another IPv6-capable network:
```bash
curl -6 https://matrix.yourdomain.com/_matrix/client/versions
```

**Why IPv6 works so well with Starlink:**
- No CGNAT — IPv6 addresses are public by default
- Starlink's IPv6 prefix is delegated per customer and rarely changes
- All modern Matrix clients (Element) support IPv6
- All modern browsers support IPv6
- No port forwarding needed on the Starlink router — the server is directly reachable

**Limitation:** Some older networks and devices don't support IPv6. If a caller is on an IPv4-only network, they can't reach your server via IPv6 alone. For maximum compatibility, combine IPv6 with a Cloudflare Tunnel (Option 3) or Tailscale (Option 4) as a fallback for IPv4 clients.

#### Option 3: Use Starlink in Bypass Mode + Your Own Router (IPv4)

1. In the Starlink app, go to **Settings** → **Network** → **Bypass Mode** (enable)
2. Connect your own router (pfSense, OpenWRT, UniFi, etc.) to the Starlink ethernet adapter
3. Your router handles NAT and port forwarding — see the guide for your specific router
4. Note: you still need a public IP — use IPv6 (Option 2) or request a public IPv4 (Option 1)

#### Option 4: Cloudflare Tunnel (No Public IP Needed)

If you can't get a public IP, use a Cloudflare Tunnel to expose your Matrix server:

```bash
# Install cloudflared
curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared
chmod +x /usr/local/bin/cloudflared

# Authenticate
cloudflared tunnel login

# Create tunnel
cloudflared tunnel create matrix

# Configure (in ~/.cloudflared/config.yml):
# tunnel: <your-tunnel-id>
# credentials-file: /root/.cloudflared/<tunnel-id>.json
# ingress:
#   - hostname: matrix.yourdomain.com
#     service: http://localhost:443
#   - service: http_status:404

# Run
cloudflared tunnel run matrix
```

**Limitation:** Cloudflare Tunnels only support HTTP/HTTPS traffic. TURN/STUN (UDP) will NOT work through a tunnel, so **voice/video calls will only work on the local network**. For voice calls over the internet, use IPv6 (Option 2), get a public IPv4 (Option 1), or use Tailscale (Option 5).

#### Option 5: VPN/Tailscale (Voice Calls Over VPN)

Use Tailscale or WireGuard to create a VPN between your devices and the Starlink server. This bypasses CGNAT entirely:

```bash
# Install Tailscale on the server
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Install Tailscale on your phone/laptop
# Connect to the same Tailscale network
# Access Matrix at http://100.x.x.x:8008 (Tailscale IP)
```

Voice calls work over Tailscale since it's a direct peer-to-peer mesh network.

## Starlink Router Port Forwarding (With Public IP)

If you have a public IP and are using the Starlink router:

1. Open the Starlink app
2. Go to **Settings** → **Advanced** → **Port Forwarding**
3. Add rules (same as any other router):

| Name | Protocol | External Port | Internal IP | Internal Port |
|---|---|---|---|---|
| Matrix HTTPS | TCP | 443 | `YOUR_SERVER_IP` | 443 |
| Matrix Federation | TCP | 8448 | `YOUR_SERVER_IP` | 8448 |
| TURN STUN | TCP+UDP | 3478 | `YOUR_SERVER_IP` | 3478 |
| TURNS TLS | TCP | 5349 | `YOUR_SERVER_IP` | 5349 |
| TURN Relay | UDP | 49152-65535 | `YOUR_SERVER_IP` | 49152-65535 |

> **Note:** Starlink router port forwarding features vary by firmware version and hardware generation. If these options aren't available, use bypass mode with your own router.

## Notes

- Starlink's IP can change frequently, even with a "public" IP. Use DynDNS (DuckDNS, etc.) to keep your domain updated.
- Starlink latency is typically 25-60ms, which is fine for Matrix and voice calls.
- If you're in a remote area with variable connectivity, configure the voice agent's call timeout (`CALL_TIMEOUT_MS`) higher to avoid premature disconnects.
