# Ubiquiti AmpliFi — Port Forwarding Guide

Works for: **AmpliFi HD, AmpliFi Instant, AmpliFi Alien**.

> **Disclaimer:** This guide is provided as a helpful reference. You assume all responsibility for securing your network and implementing these rules correctly. The authors of matrix-voip-agent are not liable for any misconfigurations or security issues.

## Prerequisites

- AmpliFi app on your phone or access to `http://amplifi.lan`
- Your server's internal IP address

## Steps

### 1. Open AmpliFi App

Tap your AmpliFi router in the app, or go to `http://amplifi.lan` in a browser.

### 2. Enable Port Forwarding

- Tap the router icon at the bottom
- Scroll down and enable **Port Forwarding** if not already enabled

### 3. Add Rules

Tap **+ Add Rule** for each:

| Name | Internal IP | Internal Port | External Port | Protocol |
|---|---|---|---|---|
| Matrix HTTPS | `YOUR_SERVER_IP` | 443 | 443 | TCP |
| Matrix Federation | `YOUR_SERVER_IP` | 8448 | 8448 | TCP |
| TURN STUN | `YOUR_SERVER_IP` | 3478 | 3478 | TCP & UDP |
| TURNS TLS | `YOUR_SERVER_IP` | 5349 | 5349 | TCP |
| TURN Relay | `YOUR_SERVER_IP` | 49152-65535 | 49152-65535 | UDP |

### 4. Save

Tap **Save** after adding each rule. Changes apply immediately.

## Notes

- AmpliFi has limited port range support. If you can't enter `49152-65535` as a range, you may need to use a smaller range like `49152-50000` and configure coturn's `min-port`/`max-port` to match.
- If voice calls don't work, check that UPnP is enabled under the router settings as a fallback.
