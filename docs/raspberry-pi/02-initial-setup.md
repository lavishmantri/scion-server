# Initial Raspberry Pi Setup

*For Raspberry Pi OS Bookworm/Trixie with NetworkManager*

## First Connection

### Find Your Pi

If you configured WiFi during flashing:

```bash
# Try mDNS hostname (may take a minute after boot)
ping scion-pi.local

# Or scan your network
arp -a | grep -i "raspberry\|dc:a6\|b8:27\|d8:3a\|e4:5f"
```

If using Ethernet, the Pi will get an IP via DHCP.

### SSH Into Your Pi

```bash
ssh pi@scion-pi.local
# Or use IP address
ssh pi@192.168.1.xxx
```

Default password is what you set during flashing, or `raspberry` if using manual setup.

---

## Essential First Steps

### Update the System

```bash
sudo apt update && sudo apt upgrade -y
```

### Change Default Password (if not set during flash)

```bash
passwd
```

### Set Hostname (if not set during flash)

```bash
sudo hostnamectl set-hostname scion-pi
```

### Configure Locale and Timezone

```bash
sudo raspi-config
```

Navigate to:
- `5 Localisation Options` → `L1 Locale` → Select your locale
- `5 Localisation Options` → `L2 Timezone` → Select your timezone

Or via command line:

```bash
# Set timezone
sudo timedatectl set-timezone America/Los_Angeles

# Set locale
sudo localectl set-locale LANG=en_US.UTF-8
```

---

## SSH Configuration

### Add Your SSH Key (Recommended)

From your Mac:

```bash
# Copy your public key to the Pi
ssh-copy-id pi@scion-pi.local
```

Or manually:

```bash
# On your Mac, copy your public key
cat ~/.ssh/id_ed25519.pub

# On the Pi, add it to authorized_keys
mkdir -p ~/.ssh
chmod 700 ~/.ssh
echo "your-public-key-here" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

### Disable Password Authentication (Optional, more secure)

After confirming key-based login works:

```bash
sudo nano /etc/ssh/sshd_config
```

Change:
```
PasswordAuthentication no
```

Restart SSH:
```bash
sudo systemctl restart ssh
```

### Keep SSH Alive

Add to your Mac's `~/.ssh/config`:

```
Host scion-pi
    HostName scion-pi.local
    User pi
    ServerAliveInterval 60
    ServerAliveCountMax 3
```

Now connect with just:
```bash
ssh scion-pi
```

---

## WiFi Configuration

Raspberry Pi OS Bookworm and Trixie use **NetworkManager** (not the old dhcpcd).

### View Current WiFi Status

```bash
# List available networks
nmcli device wifi list

# Show saved connections
nmcli connection show

# Show active connections
nmcli connection show --active

# Text UI for network management
nmtui
```

### Connect to a WiFi Network

```bash
# Connect to a network
sudo nmcli device wifi connect "SSID-Name" password "wifi-password"

# Or for hidden networks
sudo nmcli device wifi connect "SSID-Name" password "wifi-password" hidden yes
```

### Configure Multiple WiFi Networks

The Pi will automatically connect to known networks by priority.

```bash
# Add home network (high priority)
sudo nmcli connection add \
    type wifi \
    con-name "Home-WiFi" \
    ssid "Home-SSID" \
    wifi-sec.key-mgmt wpa-psk \
    wifi-sec.psk "home-password" \
    connection.autoconnect yes \
    connection.autoconnect-priority 100

# Add work/secondary network (lower priority)
sudo nmcli connection add \
    type wifi \
    con-name "Work-WiFi" \
    ssid "Work-SSID" \
    wifi-sec.key-mgmt wpa-psk \
    wifi-sec.psk "work-password" \
    connection.autoconnect yes \
    connection.autoconnect-priority 50

# Add mobile hotspot (lowest priority, fallback)
sudo nmcli connection add \
    type wifi \
    con-name "Phone-Hotspot" \
    ssid "iPhone" \
    wifi-sec.key-mgmt wpa-psk \
    wifi-sec.psk "hotspot-password" \
    connection.autoconnect yes \
    connection.autoconnect-priority 10
```

### View Configured Networks

```bash
nmcli connection show
```

### Remove a Network

```bash
sudo nmcli connection delete "Connection-Name"
```

### Manually Switch Networks

```bash
# Disconnect current
sudo nmcli device disconnect wlan0

# Connect to specific network
sudo nmcli connection up "Home-WiFi"
```

---

## Static IP (Optional)

If you want a fixed IP address:

```bash
# Find your connection name
nmcli connection show

# Edit the connection (replace "Home-WiFi" with your connection name)
sudo nmcli connection modify "Home-WiFi" \
    ipv4.method manual \
    ipv4.addresses 192.168.1.100/24 \
    ipv4.gateway 192.168.1.1 \
    ipv4.dns "8.8.8.8,8.8.4.4"

# Apply changes
sudo nmcli connection down "Home-WiFi"
sudo nmcli connection up "Home-WiFi"

# Verify
ip addr show
```

To revert to DHCP:
```bash
sudo nmcli connection modify "Home-WiFi" \
    ipv4.method auto \
    ipv4.addresses "" \
    ipv4.gateway "" \
    ipv4.dns ""
sudo nmcli connection up "Home-WiFi"
```

---

## System Monitoring

### Check System Resources

```bash
# CPU, memory, processes
htop

# If htop isn't installed
sudo apt install htop
```

### Check Disk Space

```bash
df -h
```

### Check Temperature

```bash
vcgencmd measure_temp
```

### Check Network

```bash
# IP addresses
ip addr

# Network connections
ss -tuln
```

---

## Automatic Updates (Optional)

Enable unattended security updates:

```bash
sudo apt install unattended-upgrades
sudo dpkg-reconfigure unattended-upgrades
```

---

## Next Steps

Your Pi is now configured with:
- SSH access
- Multiple WiFi networks
- Basic security

Continue to:
- [03 - Tailscale](./03-tailscale.md) - For secure remote access
- [04 - Docker](./04-docker.md) - To run Scion Sync
