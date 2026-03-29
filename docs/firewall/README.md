# Firewall and Port Forwarding Guide

To accept Matrix calls from outside your local network, your router/firewall must forward specific ports to the machine running matrix-voip-agent.

## Universal Requirements (All Firewalls)

Forward these ports from your router's WAN (public) interface to the internal IP of your server:

| Port | Protocol | Service | Required? | Notes |
|---|---|---|---|---|
| **443** | TCP | HTTPS (Caddy) | **Yes** | Matrix client API, federation, and web client |
| **8448** | TCP | Matrix federation | **Yes** for federation | Other Matrix servers connect here |
| **3478** | TCP + UDP | TURN/STUN (coturn) | **Yes** for voice/video | WebRTC NAT traversal |
| **5349** | TCP | TURNS (TURN over TLS) | Recommended | Secure TURN for restrictive networks |
| **49152–65535** | UDP | TURN relay range | **Yes** for voice/video | Media relay for WebRTC calls |

### What each port does

- **443 (HTTPS)**: All Matrix traffic — messaging, login, file uploads, Element web client. This is the main entry point.
- **8448 (Federation)**: Other Matrix servers (matrix.org, etc.) use this to send messages to your users and discover your server.
- **3478 (TURN/STUN)**: Helps WebRTC calls punch through NAT. Without this, voice/video calls only work on your LAN.
- **5349 (TURNS)**: Same as 3478 but over TLS. Helps in environments that block non-HTTPS traffic (corporate networks, some mobile carriers).
- **49152–65535 (TURN relay)**: Actual media streams flow through these ports when direct peer-to-peer isn't possible. coturn allocates ports from this range dynamically.

### Minimum for text chat only

If you only want text messaging (no voice/video calls), you only need:
- **443** TCP
- **8448** TCP

### Minimum for voice calls

For voice calls to work from outside your LAN, you need all five entries above.

### How to find your server's internal IP

On the machine running the server:
```bash
hostname -I | awk '{print $1}'
```

This is the IP you'll use as the "destination" or "internal IP" in your port forwarding rules.

---

## Firewall Guides by Brand

Step-by-step guides for common home routers and firewalls:

| Brand | Guide |
|---|---|
| Ubiquiti UniFi (UDM Pro, UDM SE, USG, etc.) | [unifi.md](unifi.md) |
| Ubiquiti AmpliFi | [amplifi.md](amplifi.md) |
| pfSense | [pfsense.md](pfsense.md) |
| OPNsense | [opnsense.md](opnsense.md) |
| OpenWRT | [openwrt.md](openwrt.md) |
| Eero | [eero.md](eero.md) |
| Netgear (Nighthawk, Orbi) | [netgear.md](netgear.md) |
| Linksys | [linksys.md](linksys.md) |
| TP-Link (Deco, Archer) | [tplink.md](tplink.md) |
| Asus (RT, ROG, ZenWiFi) | [asus.md](asus.md) |
| Google Nest WiFi / Google WiFi | [google-nest.md](google-nest.md) |
| Starlink | [starlink.md](starlink.md) |

Can't find your router? Use the [Universal Requirements](#universal-requirements-all-firewalls) above — the ports and protocols are the same for all firewalls.

---

## Security Considerations

- **Only forward the ports listed above.** Do not forward SSH (22), database (5432), or internal service ports (8008, 8178, 8179).
- **Use strong passwords** for Matrix accounts and the voice agent API.
- **Keep software updated** — Dendrite, coturn, and Caddy all receive security patches.
- **Caddy handles TLS automatically** — you don't need to manually manage certificates.
- **coturn's shared secret** is auto-generated during setup and never exposed publicly.
- Consider enabling **rate limiting** on your firewall for the TURN port range to prevent abuse.
