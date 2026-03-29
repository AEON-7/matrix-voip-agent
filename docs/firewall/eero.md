# Eero — Port Forwarding Guide

Works for: **Eero 6, Eero 6+, Eero Pro 6, Eero Pro 6E, Eero Max 7**, and all Eero models.

> **Disclaimer:** This guide is provided as a helpful reference. You assume all responsibility for securing your network and implementing these rules correctly. The authors of matrix-voip-agent are not liable for any misconfigurations or security issues.

## Prerequisites

- Eero app on your phone
- Your server's internal IP address

## Important Limitation

Eero does **not** support port ranges in a single rule. You'll need to create the TURN relay rule differently (see notes below).

## Steps

### 1. Open the Eero App

Tap **Settings** → **Network Settings** → **Port Forwarding** (under Advanced).

### 2. Add Rules

Tap **Add a port forwarding rule** for each:

| Name | IP Address | External Port | Internal Port | Protocol |
|---|---|---|---|---|
| Matrix HTTPS | `YOUR_SERVER_IP` | 443 | 443 | TCP |
| Matrix Federation | `YOUR_SERVER_IP` | 8448 | 8448 | TCP |
| TURN STUN TCP | `YOUR_SERVER_IP` | 3478 | 3478 | TCP |
| TURN STUN UDP | `YOUR_SERVER_IP` | 3478 | 3478 | UDP |
| TURNS TLS | `YOUR_SERVER_IP` | 5349 | 5349 | TCP |

### 3. TURN Relay Range

Eero doesn't support port ranges. For the TURN relay range, you have two options:

**Option A (Recommended):** Configure coturn to use a smaller port range and create individual rules:

Edit your coturn config to limit the relay range:
```
min-port=49152
max-port=49200
```

Then create rules for a few key ports, or use UPnP (Settings → Network Settings → UPnP → Enable).

**Option B:** Enable UPnP in the Eero app (Settings → Network Settings → UPnP) and let coturn request ports dynamically. This is less secure but simpler.

### 4. Save

Each rule saves automatically when you tap **Save**.

## Notes

- Eero requires separate rules for TCP and UDP on the same port.
- If voice calls work on WiFi but not cellular, the TURN relay ports are likely the issue — try enabling UPnP as a workaround.
- Eero doesn't have a web interface — all configuration is through the app.
