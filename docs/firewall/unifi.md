# Ubiquiti UniFi — Port Forwarding Guide

Works for: **UDM Pro, UDM SE, UDM, USG, USG Pro, UCG Ultra**, and most UniFi gateways.

> **Disclaimer:** This guide is provided as a helpful reference. You assume all responsibility for securing your network and implementing these rules correctly. The authors of matrix-voip-agent are not liable for any misconfigurations or security issues. If unsure, consult Ubiquiti's official documentation.

## Prerequisites

- Admin access to your UniFi Controller (Network application)
- Your server's internal IP address (run `hostname -I | awk '{print $1}'` on the server)

## Steps

### 1. Open UniFi Network

Log in to your UniFi Controller at `https://unifi.local` or `https://YOUR_UDM_IP`.

### 2. Navigate to Port Forwarding

- Go to **Settings** (gear icon)
- Select **Firewall & Security** (or **Routing & Firewall** on older versions)
- Click **Port Forwarding**

### 3. Create Port Forwarding Rules

Click **Create New Rule** for each of the following:

#### Rule 1: HTTPS (Matrix)
| Field | Value |
|---|---|
| Name | Matrix HTTPS |
| Enabled | ✓ |
| From | Any |
| Port | 443 |
| Forward IP | `YOUR_SERVER_IP` |
| Forward Port | 443 |
| Protocol | TCP |

#### Rule 2: Matrix Federation
| Field | Value |
|---|---|
| Name | Matrix Federation |
| Enabled | ✓ |
| From | Any |
| Port | 8448 |
| Forward IP | `YOUR_SERVER_IP` |
| Forward Port | 8448 |
| Protocol | TCP |

#### Rule 3: TURN/STUN (Voice/Video)
| Field | Value |
|---|---|
| Name | TURN STUN |
| Enabled | ✓ |
| From | Any |
| Port | 3478 |
| Forward IP | `YOUR_SERVER_IP` |
| Forward Port | 3478 |
| Protocol | Both (TCP + UDP) |

#### Rule 4: TURNS (TLS)
| Field | Value |
|---|---|
| Name | TURNS TLS |
| Enabled | ✓ |
| From | Any |
| Port | 5349 |
| Forward IP | `YOUR_SERVER_IP` |
| Forward Port | 5349 |
| Protocol | TCP |

#### Rule 5: TURN Relay Range
| Field | Value |
|---|---|
| Name | TURN Relay |
| Enabled | ✓ |
| From | Any |
| Port | 49152-65535 |
| Forward IP | `YOUR_SERVER_IP` |
| Forward Port | 49152-65535 |
| Protocol | UDP |

### 4. Apply Changes

Click **Apply Changes**. Rules take effect immediately on UniFi gateways.

### 5. Verify

From outside your network (e.g., using mobile data):
```bash
curl -sf https://YOUR_DOMAIN/_matrix/client/versions
```

## Notes

- UniFi gateways apply port forwarding rules automatically — no reboot needed.
- If you have multiple WAN connections, make sure the rules are on the correct WAN interface.
- UniFi's "Threat Management" (IPS/IDS) may interfere with high-volume TURN traffic. If voice calls have issues, try adding your server's IP to the IPS allowlist.
