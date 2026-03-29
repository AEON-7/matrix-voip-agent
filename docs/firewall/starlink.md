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

#### Option 2: Use Starlink in Bypass Mode + Your Own Router

1. In the Starlink app, go to **Settings** → **Network** → **Bypass Mode** (enable)
2. Connect your own router (pfSense, OpenWRT, UniFi, etc.) to the Starlink ethernet adapter
3. Your router handles NAT and port forwarding — see the guide for your specific router
4. Note: you still need a public IP (Option 1) for this to work for incoming connections

#### Option 3: Cloudflare Tunnel (No Public IP Needed)

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

**Limitation:** Cloudflare Tunnels only support HTTP/HTTPS traffic. TURN/STUN (UDP) will NOT work through a tunnel, so **voice/video calls will only work on the local network**. For voice calls over the internet, you need a public IP (Option 1 or 2).

#### Option 4: VPN/Tailscale (Voice Calls Over VPN)

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
