# OPNsense — Port Forwarding Guide

Works for: **OPNsense** on any hardware (Deciso appliances, custom builds, VMs).

> **Disclaimer:** This guide is provided as a helpful reference. You assume all responsibility for securing your network and implementing these rules correctly. The authors of matrix-voip-agent are not liable for any misconfigurations or security issues.

## Prerequisites

- Admin access to OPNsense web UI
- Your server's internal IP address

## Steps

### 1. Create an Alias (Optional but Recommended)

Go to **Firewall → Aliases** and create an alias for your server:

| Field | Value |
|---|---|
| Name | matrix_server |
| Type | Host(s) |
| Content | `YOUR_SERVER_IP` |
| Description | Matrix homeserver |

### 2. Create Port Forwarding Rules

Go to **Firewall → NAT → Port Forward** and click **+ Add** for each:

| Interface | Protocol | Destination Port | Redirect Target | Redirect Port | Description |
|---|---|---|---|---|---|
| WAN | TCP | 443 | matrix_server | 443 | Matrix HTTPS |
| WAN | TCP | 8448 | matrix_server | 8448 | Matrix Federation |
| WAN | TCP/UDP | 3478 | matrix_server | 3478 | TURN STUN |
| WAN | TCP | 5349 | matrix_server | 5349 | TURNS TLS |
| WAN | UDP | 49152-65535 | matrix_server | 49152 | TURN Relay |

For each rule, check **Filter rule association → Add associated filter rule**.

### 3. Apply Changes

Click **Apply Changes**.

### 4. Verify

Go to **Firewall → Rules → WAN** to confirm the auto-generated allow rules.

## Notes

- OPNsense supports TCP/UDP combined in a single rule, unlike pfSense.
- Use **Firewall → Diagnostics → pfTop** to monitor active connections if troubleshooting.
- Consider enabling **Firewall → Settings → Advanced → Static route filtering** if you have complex routing.
