# Netgear — Port Forwarding Guide

Works for: **Nighthawk, Orbi, and most Netgear routers**.

> **Disclaimer:** This guide is provided as a helpful reference. You assume all responsibility for securing your network and implementing these rules correctly. The authors of matrix-voip-agent are not liable for any misconfigurations or security issues.

## Prerequisites

- Access to Netgear admin panel at `http://routerlogin.net` or `http://192.168.1.1`
- Your server's internal IP address

## Steps

### 1. Log in

Go to `http://routerlogin.net` and log in with your admin credentials.

### 2. Navigate to Port Forwarding

Go to **Advanced** → **Advanced Setup** → **Port Forwarding / Port Triggering**.

Select **Port Forwarding** and click **Add Custom Service**.

### 3. Add Rules

| Service Name | Protocol | External Start Port | External End Port | Internal IP | Internal Start Port |
|---|---|---|---|---|---|
| Matrix HTTPS | TCP | 443 | 443 | `YOUR_SERVER_IP` | 443 |
| Matrix Federation | TCP | 8448 | 8448 | `YOUR_SERVER_IP` | 8448 |
| TURN STUN TCP | TCP | 3478 | 3478 | `YOUR_SERVER_IP` | 3478 |
| TURN STUN UDP | UDP | 3478 | 3478 | `YOUR_SERVER_IP` | 3478 |
| TURNS TLS | TCP | 5349 | 5349 | `YOUR_SERVER_IP` | 5349 |
| TURN Relay | UDP | 49152 | 65535 | `YOUR_SERVER_IP` | 49152 |

Click **Apply** after each rule.

### For Orbi Systems

On Orbi, port forwarding is on the **router** (not satellites):
- Open `http://orbilogin.net`
- Go to **Advanced** → **Advanced Setup** → **Port Forwarding**
- Same rules as above

## Notes

- Netgear supports port ranges natively (start port to end port).
- If "Port Forwarding" is grayed out, make sure your router is in **Router Mode** (not AP mode or Bridge mode).
- Some Nighthawk models have port forwarding under **Security** instead of **Advanced Setup**.
