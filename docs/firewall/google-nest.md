# Google Nest WiFi / Google WiFi — Port Forwarding Guide

Works for: **Google Nest WiFi Pro, Nest WiFi, Google WiFi (all generations)**.

> **Disclaimer:** This guide is provided as a helpful reference. You assume all responsibility for securing your network and implementing these rules correctly. The authors of matrix-voip-agent are not liable for any misconfigurations or security issues.

## Prerequisites

- Google Home app on your phone
- Your server's internal IP address

## Important Limitation

Google Nest WiFi / Google WiFi has **very limited** port forwarding capabilities:
- **No port range support** — you must create individual rules for each port
- **All configuration is through the Google Home app** — no web interface

For the TURN relay range (49152-65535), this is impractical. See workaround below.

## Steps

### 1. Open Google Home App

Tap **Wi-Fi** → **Settings** (gear icon) → **Advanced networking** → **Port management**.

### 2. Add Rules

Tap **+** to add each:

| Name | Internal IP | Protocol | External Port | Internal Port |
|---|---|---|---|---|
| Matrix HTTPS | `YOUR_SERVER_IP` | TCP | 443 | 443 |
| Matrix Federation | `YOUR_SERVER_IP` | TCP | 8448 | 8448 |
| TURN STUN TCP | `YOUR_SERVER_IP` | TCP | 3478 | 3478 |
| TURN STUN UDP | `YOUR_SERVER_IP` | UDP | 3478 | 3478 |
| TURNS TLS | `YOUR_SERVER_IP` | TCP | 5349 | 5349 |

### 3. TURN Relay Workaround

Google WiFi doesn't support port ranges. For the TURN relay:

**Recommended:** Put your Google WiFi in **bridge mode** and use a separate firewall/router (pfSense, OpenWRT, etc.) that supports port ranges. Google WiFi then handles WiFi only.

**Alternative:** Configure coturn with a very small relay range:
```
min-port=49152
max-port=49160
```
Then create 9 individual rules in the Google Home app for ports 49152-49160 (UDP). This limits concurrent call capacity but works.

### 4. Save

Rules save automatically.

## Notes

- Google Nest WiFi requires the Google Home app — there is no web interface or CLI.
- Separate TCP and UDP rules are required for the same port.
- If you need extensive port forwarding, consider running Google WiFi in bridge mode behind a more capable router.
- Google WiFi's "Port management" may be under different menu paths depending on app version.
