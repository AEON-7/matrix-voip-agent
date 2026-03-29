# Linksys — Port Forwarding Guide

Works for: **Linksys Velop, EA series, WRT series**, and most Linksys routers.

> **Disclaimer:** This guide is provided as a helpful reference. You assume all responsibility for securing your network and implementing these rules correctly. The authors of matrix-voip-agent are not liable for any misconfigurations or security issues.

## Prerequisites

- Access to Linksys admin panel at `http://192.168.1.1` or via the Linksys app
- Your server's internal IP address

## Steps (Web Interface)

### 1. Log in

Go to `http://192.168.1.1` and enter your admin password.

### 2. Navigate to Port Forwarding

Go to **Security** → **Apps and Gaming** → **Single Port Forwarding** or **Port Range Forwarding**.

### 3. Add Single Port Rules

Under **Single Port Forwarding**:

| Application | External Port | Internal Port | Protocol | Device IP |
|---|---|---|---|---|
| Matrix HTTPS | 443 | 443 | TCP | `YOUR_SERVER_IP` |
| Matrix Federation | 8448 | 8448 | TCP | `YOUR_SERVER_IP` |
| TURN STUN TCP | 3478 | 3478 | TCP | `YOUR_SERVER_IP` |
| TURN STUN UDP | 3478 | 3478 | UDP | `YOUR_SERVER_IP` |
| TURNS TLS | 5349 | 5349 | TCP | `YOUR_SERVER_IP` |

Check **Enabled** for each rule.

### 4. Add Port Range Rule

Under **Port Range Forwarding**:

| Application | Start Port | End Port | Protocol | Device IP |
|---|---|---|---|---|
| TURN Relay | 49152 | 65535 | UDP | `YOUR_SERVER_IP` |

### 5. Save

Click **Save Settings** (or **Apply**).

## Steps (Linksys App)

1. Open the Linksys app
2. Tap **Advanced Settings** → **Port Forwarding**
3. Add the same rules as above
4. Save

## Notes

- Older Linksys models may use "Apps and Gaming" instead of "Security" for port forwarding.
- Linksys Velop systems: port forwarding is configured on the primary node only.
- If you can't find port forwarding, ensure the router is in **Router mode** (not Bridge mode).
