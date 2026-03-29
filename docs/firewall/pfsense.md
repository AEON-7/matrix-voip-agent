# pfSense — Port Forwarding Guide

Works for: **pfSense CE and pfSense Plus** on any hardware (Netgate appliances, custom builds, VMs).

> **Disclaimer:** This guide is provided as a helpful reference. You assume all responsibility for securing your network and implementing these rules correctly. The authors of matrix-voip-agent are not liable for any misconfigurations or security issues.

## Prerequisites

- Admin access to pfSense web UI (typically `https://192.168.1.1`)
- Your server's internal IP address

## Steps

### 1. Log in to pfSense

Navigate to `https://YOUR_PFSENSE_IP` and log in.

### 2. Create Port Forwarding Rules

Go to **Firewall → NAT → Port Forward** and click **Add** (↑) for each rule:

#### Rule 1: HTTPS (Matrix)
| Field | Value |
|---|---|
| Interface | WAN |
| Protocol | TCP |
| Destination | WAN address |
| Destination Port Range | 443 to 443 |
| Redirect Target IP | `YOUR_SERVER_IP` |
| Redirect Target Port | 443 |
| Description | Matrix HTTPS |

#### Rule 2: Matrix Federation
| Field | Value |
|---|---|
| Interface | WAN |
| Protocol | TCP |
| Destination | WAN address |
| Destination Port Range | 8448 to 8448 |
| Redirect Target IP | `YOUR_SERVER_IP` |
| Redirect Target Port | 8448 |
| Description | Matrix Federation |

#### Rule 3: TURN/STUN (TCP)
| Field | Value |
|---|---|
| Interface | WAN |
| Protocol | TCP |
| Destination | WAN address |
| Destination Port Range | 3478 to 3478 |
| Redirect Target IP | `YOUR_SERVER_IP` |
| Redirect Target Port | 3478 |
| Description | TURN TCP |

#### Rule 4: TURN/STUN (UDP)
| Field | Value |
|---|---|
| Interface | WAN |
| Protocol | UDP |
| Destination | WAN address |
| Destination Port Range | 3478 to 3478 |
| Redirect Target IP | `YOUR_SERVER_IP` |
| Redirect Target Port | 3478 |
| Description | TURN UDP |

#### Rule 5: TURNS (TLS)
| Field | Value |
|---|---|
| Interface | WAN |
| Protocol | TCP |
| Destination | WAN address |
| Destination Port Range | 5349 to 5349 |
| Redirect Target IP | `YOUR_SERVER_IP` |
| Redirect Target Port | 5349 |
| Description | TURNS TLS |

#### Rule 6: TURN Relay Range
| Field | Value |
|---|---|
| Interface | WAN |
| Protocol | UDP |
| Destination | WAN address |
| Destination Port Range | 49152 to 65535 |
| Redirect Target IP | `YOUR_SERVER_IP` |
| Redirect Target Port | 49152 |
| Description | TURN Relay |

> **Note:** Check "Filter rule association: Add associated filter rule" for each to automatically create the matching firewall allow rule.

### 3. Apply Changes

Click **Apply Changes** at the top of the page.

### 4. Verify Firewall Rules

Go to **Firewall → Rules → WAN** and confirm the associated allow rules were created for each port forward.

## Notes

- pfSense requires separate rules for TCP and UDP on the same port (unlike some routers that support "Both").
- If you have multiple WAN interfaces, create the rules on the correct WAN.
- pfSense's packet capture tool (**Diagnostics → Packet Capture**) is useful for debugging if traffic isn't reaching your server.
- Consider adding a firewall alias for the TURN relay range to keep rules organized.
