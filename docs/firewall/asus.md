# Asus — Port Forwarding Guide

Works for: **RT series, ROG Rapture, ZenWiFi, and most Asus routers** (including those running Asuswrt-Merlin).

> **Disclaimer:** This guide is provided as a helpful reference. You assume all responsibility for securing your network and implementing these rules correctly. The authors of matrix-voip-agent are not liable for any misconfigurations or security issues.

## Prerequisites

- Access to Asus admin panel at `http://router.asus.com` or `http://192.168.1.1` (or `http://192.168.50.1` for some models)
- Your server's internal IP address

## Steps

### 1. Log in

Go to `http://router.asus.com` and log in.

### 2. Navigate to Port Forwarding

Go to **WAN** → **Virtual Server / Port Forwarding**.

### 3. Enable Port Forwarding

Set **Enable Port Forwarding** to **Yes**.

### 4. Add Rules

| Service Name | Protocol | External Port | Internal IP | Internal Port |
|---|---|---|---|---|
| Matrix HTTPS | TCP | 443 | `YOUR_SERVER_IP` | 443 |
| Matrix Federation | TCP | 8448 | `YOUR_SERVER_IP` | 8448 |
| TURN STUN | BOTH | 3478 | `YOUR_SERVER_IP` | 3478 |
| TURNS TLS | TCP | 5349 | `YOUR_SERVER_IP` | 5349 |
| TURN Relay | UDP | 49152:65535 | `YOUR_SERVER_IP` | 49152:65535 |

Click the **+** button after each row, then click **Apply**.

> **Note:** Asus uses `:` for port ranges (e.g., `49152:65535`), not `-`.

### 5. Apply

Click **Apply** at the bottom of the page.

## Notes

- Asus routers support the "BOTH" protocol option for TCP+UDP on the same port.
- Asus uses colon (`:`) for port ranges, not dash (`-`).
- Asuswrt-Merlin firmware has the same interface — these steps work for both stock and Merlin.
- AiMesh setups: configure port forwarding on the primary (AiMesh router) node only.
- If using AiProtection (Trend Micro), it shouldn't interfere with port forwarding, but check the firewall logs if having issues.
