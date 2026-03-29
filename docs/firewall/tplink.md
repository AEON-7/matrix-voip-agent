# TP-Link — Port Forwarding Guide

Works for: **Deco (all models), Archer series, and most TP-Link routers**.

> **Disclaimer:** This guide is provided as a helpful reference. You assume all responsibility for securing your network and implementing these rules correctly. The authors of matrix-voip-agent are not liable for any misconfigurations or security issues.

## For Deco Systems (App Only)

### 1. Open the Deco App

Tap **More** → **Advanced** → **Port Forwarding**.

### 2. Add Rules

Tap **+** to add each rule:

| Name | External Port | Internal IP | Internal Port | Protocol |
|---|---|---|---|---|
| Matrix HTTPS | 443 | `YOUR_SERVER_IP` | 443 | TCP |
| Matrix Federation | 8448 | `YOUR_SERVER_IP` | 8448 | TCP |
| TURN STUN | 3478 | `YOUR_SERVER_IP` | 3478 | TCP & UDP |
| TURNS TLS | 5349 | `YOUR_SERVER_IP` | 5349 | TCP |
| TURN Relay | 49152-65535 | `YOUR_SERVER_IP` | 49152-65535 | UDP |

### 3. Save

Tap **Save** after each rule. If Deco doesn't support port ranges, see the workaround in Notes.

## For Archer / Other TP-Link Routers (Web Interface)

### 1. Log in

Go to `http://tplinkwifi.net` or `http://192.168.0.1`.

### 2. Navigate

Go to **Advanced** → **NAT Forwarding** → **Port Forwarding** (or **Virtual Servers**).

### 3. Add Rules

Click **Add** for each:

| Service Name | External Port | Internal IP | Internal Port | Protocol |
|---|---|---|---|---|
| Matrix HTTPS | 443 | `YOUR_SERVER_IP` | 443 | TCP |
| Matrix Federation | 8448 | `YOUR_SERVER_IP` | 8448 | TCP |
| TURN STUN | 3478 | `YOUR_SERVER_IP` | 3478 | ALL |
| TURNS TLS | 5349 | `YOUR_SERVER_IP` | 5349 | TCP |
| TURN Relay | 49152-65535 | `YOUR_SERVER_IP` | 49152-65535 | UDP |

### 4. Save

Click **Save**.

## Notes

- Some Deco models have limited port forwarding features. If port ranges aren't supported, limit coturn's range (`min-port=49152`, `max-port=49200`) and forward that smaller range.
- TP-Link's default gateway IP is `192.168.0.1` (not `192.168.1.1` like most routers).
- Make sure **NAT** is enabled (it should be by default in Router mode).
