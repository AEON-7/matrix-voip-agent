# OpenWRT — Port Forwarding Guide

Works for: **Any router running OpenWRT** (custom firmware).

> **Disclaimer:** This guide is provided as a helpful reference. You assume all responsibility for securing your network and implementing these rules correctly. The authors of matrix-voip-agent are not liable for any misconfigurations or security issues.

## Option 1: LuCI Web Interface

### 1. Log in to LuCI

Navigate to `http://192.168.1.1` (or your router's IP).

### 2. Navigate to Port Forwards

Go to **Network → Firewall → Port Forwards**.

### 3. Add Rules

Click **Add** for each:

| Name | Protocol | External Port | Internal IP | Internal Port |
|---|---|---|---|---|
| Matrix HTTPS | TCP | 443 | `YOUR_SERVER_IP` | 443 |
| Matrix Federation | TCP | 8448 | `YOUR_SERVER_IP` | 8448 |
| TURN STUN | TCP+UDP | 3478 | `YOUR_SERVER_IP` | 3478 |
| TURNS TLS | TCP | 5349 | `YOUR_SERVER_IP` | 5349 |
| TURN Relay | UDP | 49152-65535 | `YOUR_SERVER_IP` | 49152-65535 |

### 4. Save & Apply

Click **Save & Apply** at the bottom.

## Option 2: SSH / Command Line

```bash
# SSH into your OpenWRT router
ssh root@192.168.1.1

# Add port forwarding rules
uci add firewall redirect
uci set firewall.@redirect[-1].name='Matrix HTTPS'
uci set firewall.@redirect[-1].src='wan'
uci set firewall.@redirect[-1].dest='lan'
uci set firewall.@redirect[-1].proto='tcp'
uci set firewall.@redirect[-1].src_dport='443'
uci set firewall.@redirect[-1].dest_ip='YOUR_SERVER_IP'
uci set firewall.@redirect[-1].dest_port='443'
uci set firewall.@redirect[-1].target='DNAT'

uci add firewall redirect
uci set firewall.@redirect[-1].name='Matrix Federation'
uci set firewall.@redirect[-1].src='wan'
uci set firewall.@redirect[-1].dest='lan'
uci set firewall.@redirect[-1].proto='tcp'
uci set firewall.@redirect[-1].src_dport='8448'
uci set firewall.@redirect[-1].dest_ip='YOUR_SERVER_IP'
uci set firewall.@redirect[-1].dest_port='8448'
uci set firewall.@redirect[-1].target='DNAT'

uci add firewall redirect
uci set firewall.@redirect[-1].name='TURN STUN'
uci set firewall.@redirect[-1].src='wan'
uci set firewall.@redirect[-1].dest='lan'
uci set firewall.@redirect[-1].proto='tcpudp'
uci set firewall.@redirect[-1].src_dport='3478'
uci set firewall.@redirect[-1].dest_ip='YOUR_SERVER_IP'
uci set firewall.@redirect[-1].dest_port='3478'
uci set firewall.@redirect[-1].target='DNAT'

uci add firewall redirect
uci set firewall.@redirect[-1].name='TURNS TLS'
uci set firewall.@redirect[-1].src='wan'
uci set firewall.@redirect[-1].dest='lan'
uci set firewall.@redirect[-1].proto='tcp'
uci set firewall.@redirect[-1].src_dport='5349'
uci set firewall.@redirect[-1].dest_ip='YOUR_SERVER_IP'
uci set firewall.@redirect[-1].dest_port='5349'
uci set firewall.@redirect[-1].target='DNAT'

uci add firewall redirect
uci set firewall.@redirect[-1].name='TURN Relay'
uci set firewall.@redirect[-1].src='wan'
uci set firewall.@redirect[-1].dest='lan'
uci set firewall.@redirect[-1].proto='udp'
uci set firewall.@redirect[-1].src_dport='49152-65535'
uci set firewall.@redirect[-1].dest_ip='YOUR_SERVER_IP'
uci set firewall.@redirect[-1].dest_port='49152-65535'
uci set firewall.@redirect[-1].target='DNAT'

# Save and apply
uci commit firewall
/etc/init.d/firewall restart
```

## Notes

- Replace `YOUR_SERVER_IP` with your server's actual LAN IP.
- OpenWRT supports port ranges natively in both LuCI and UCI.
- Use `logread -f` on the router to debug firewall issues in real time.
