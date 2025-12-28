# Hotspot Mode (Offline Sync)

Run your Pi as a WiFi access point for fully offline Obsidian sync - no internet required on any device.

## Architecture

```
┌─────────────────┐         WiFi AP         ┌─────────────────┐
│   iPhone/Mac    │ ──────────────────────► │  Raspberry Pi   │
│   (Obsidian)    │    "ScionSync"          │  (Scion Server) │
│                 │    10.42.0.x            │   10.42.0.1     │
└─────────────────┘                         └─────────────────┘
              No internet needed
```

## Prerequisites

- Raspberry Pi 3/4/5 (built-in WiFi required)
- Raspberry Pi OS Bookworm or Trixie (uses NetworkManager)
- Scion server deployed ([Guide 05](./05-scion-deployment.md))
- SSH access to Pi (via Ethernet or existing WiFi)

---

## Quick Setup (NetworkManager Method)

Raspberry Pi OS Bookworm/Trixie uses NetworkManager, so creating a hotspot is a single command - no hostapd or dnsmasq needed.

### One-Command Setup

```bash
sudo nmcli device wifi hotspot ifname wlan0 con-name ScionAP ssid ScionSync password "YourPassword123"
```

That's it! Your Pi is now broadcasting "ScionSync" WiFi.

### Verify Hotspot is Running

```bash
nmcli connection show --active
```

You should see `ScionAP` listed.

---

## Customized Setup

For more control over the configuration:

### Create Hotspot with Custom Settings

```bash
sudo nmcli connection add \
    type wifi \
    ifname wlan0 \
    con-name ScionAP \
    autoconnect yes \
    ssid "ScionSync" \
    mode ap \
    802-11-wireless.band bg \
    802-11-wireless.channel 6 \
    ipv4.method shared \
    ipv4.addresses 192.168.4.1/24 \
    wifi-sec.key-mgmt wpa-psk \
    wifi-sec.psk "YourSecurePassword"
```

### Configuration Options

| Option | Description | Recommended |
|--------|-------------|-------------|
| `ssid` | Network name | `ScionSync` |
| `802-11-wireless.band` | `bg` (2.4GHz) or `a` (5GHz) | `bg` for compatibility |
| `802-11-wireless.channel` | 1-11 for 2.4GHz | 1, 6, or 11 |
| `ipv4.addresses` | Pi's IP address | `192.168.4.1/24` |
| `wifi-sec.psk` | Password (min 8 chars) | Strong password |

### Activate the Hotspot

```bash
sudo nmcli connection up ScionAP
```

---

## Auto-Start on Boot

The hotspot will auto-start if you set `autoconnect yes` (included in the command above).

To verify:

```bash
nmcli connection show ScionAP | grep autoconnect
```

To enable auto-start manually:

```bash
sudo nmcli connection modify ScionAP connection.autoconnect yes
```

---

## Connect and Test

### From Your Device

1. Open WiFi settings
2. Connect to `ScionSync`
3. Enter your password

### Default IP Addresses

| Method | Pi IP | DHCP Range |
|--------|-------|------------|
| Quick hotspot | `10.42.0.1` | `10.42.0.x` |
| Custom setup | `192.168.4.1` | `192.168.4.x` |

### Test Connection

```bash
# From connected device (use correct IP based on your setup)
curl http://10.42.0.1:3000/health
# or
curl http://192.168.4.1:3000/health
```

Expected: `{"status":"ok"}`

---

## Configure Obsidian Plugin

In Obsidian settings, set server URL to:

```
http://10.42.0.1:3000
```

Or if using custom IP:

```
http://192.168.4.1:3000
```

---

## Dual-Mode: Hotspot + Internet via Ethernet

Use Ethernet for internet while WiFi serves as hotspot.

### Setup

1. Connect Pi to router via Ethernet cable
2. Create hotspot on WiFi (commands above)
3. Internet traffic is automatically shared with hotspot clients

NetworkManager handles NAT automatically when using `ipv4.method shared`.

---

## Switching Between Modes

### View All Connections

```bash
nmcli connection show
```

### Switch to Hotspot Mode

```bash
sudo nmcli connection up ScionAP
```

### Switch Back to WiFi Client Mode

```bash
sudo nmcli connection down ScionAP
sudo nmcli connection up "Your-Home-WiFi"
```

### Create Toggle Scripts

**Enable Hotspot** (`~/hotspot-on.sh`):
```bash
#!/bin/bash
sudo nmcli connection up ScionAP
echo "Hotspot enabled: ScionSync"
echo "Pi IP: $(nmcli -g IP4.ADDRESS connection show ScionAP | cut -d/ -f1)"
```

**Disable Hotspot** (`~/hotspot-off.sh`):
```bash
#!/bin/bash
sudo nmcli connection down ScionAP
echo "Hotspot disabled"
```

Make executable:
```bash
chmod +x ~/hotspot-on.sh ~/hotspot-off.sh
```

---

## Troubleshooting

### Hotspot Not Visible

```bash
# Check connection status
nmcli connection show ScionAP

# Check for errors
journalctl -u NetworkManager -n 50

# Try different channel
sudo nmcli connection modify ScionAP 802-11-wireless.channel 1
sudo nmcli connection up ScionAP
```

### Can't Connect (Password Correct)

Disable Protected Management Frames if having issues:

```bash
sudo nmcli connection modify ScionAP wifi-sec.pmf disable
sudo nmcli connection up ScionAP
```

### WiFi Interface Busy

```bash
# Check what's using wlan0
nmcli device status

# Disconnect any existing WiFi connection
sudo nmcli device disconnect wlan0

# Then start hotspot
sudo nmcli connection up ScionAP
```

### Check DHCP Leases

```bash
# View connected clients
cat /var/lib/NetworkManager/dnsmasq-wlan0.leases
```

### Delete and Recreate Hotspot

```bash
sudo nmcli connection delete ScionAP
# Then run the setup command again
```

---

## Security

### Use Strong Password

At least 12 characters with mixed case, numbers, symbols.

### Hide SSID (Optional)

```bash
sudo nmcli connection modify ScionAP 802-11-wireless.hidden yes
```

Devices must manually enter the network name to connect.

### Firewall (UFW)

Restrict access to only necessary ports:

```bash
sudo apt install ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing

# Allow from hotspot subnet only
sudo ufw allow from 10.42.0.0/24 to any port 3000  # Scion
sudo ufw allow from 10.42.0.0/24 to any port 22    # SSH

sudo ufw enable
```

---

## Quick Reference

| Setting | Default Value |
|---------|---------------|
| SSID | `ScionSync` |
| Pi IP (quick) | `10.42.0.1` |
| Pi IP (custom) | `192.168.4.1` |
| Scion URL | `http://10.42.0.1:3000` |
| Connection name | `ScionAP` |
| Config location | `/etc/NetworkManager/system-connections/ScionAP.nmconnection` |

---

## Legacy Method (hostapd/dnsmasq)

If you need the old hostapd/dnsmasq method (not recommended for Bookworm/Trixie), see the [Raspberry Pi documentation](https://www.raspberrypi.com/documentation/computers/configuration.html#setting-up-a-routed-wireless-access-point).

The NetworkManager method above is simpler and better integrated with modern Raspberry Pi OS.
