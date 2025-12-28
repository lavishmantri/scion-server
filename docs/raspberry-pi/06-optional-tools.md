# Optional Tools

Additional tools to enhance your Raspberry Pi setup.

## Raspberry Pi Connect

Official remote access tool from Raspberry Pi Foundation. Provides screen sharing and remote shell without Tailscale.

### Install

```bash
sudo apt install rpi-connect
```

### Setup

```bash
# Start the service
rpi-connect signin
```

Follow the URL to sign in with your Raspberry Pi ID.

### Access

Visit https://connect.raspberrypi.com to access your Pi from anywhere.

### Use Cases

- Quick access without VPN
- Screen sharing (if running desktop)
- Backup remote access method

### Note

Tailscale is generally preferred for server use as it's more flexible and doesn't require a Raspberry Pi account.

---

## Monitoring with Glances

A terminal-based system monitor.

### Install

```bash
sudo apt install glances
```

### Usage

```bash
# Local monitoring
glances

# Web interface
glances -w
# Access at http://pi-ip:61208
```

### Run as Service

```bash
sudo tee /etc/systemd/system/glances.service << 'EOF'
[Unit]
Description=Glances
After=network.target

[Service]
ExecStart=/usr/bin/glances -w
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable --now glances
```

---

## Portainer (Docker Web UI)

Web-based Docker management interface.

### Install

```bash
docker volume create portainer_data

docker run -d \
  -p 9000:9000 \
  --name portainer \
  --restart=always \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v portainer_data:/data \
  portainer/portainer-ce:latest
```

### Access

Open http://scion-pi:9000 and create an admin account.

### Features

- Visual container management
- Log viewing
- Resource monitoring
- Image management

---

## Log Management with Dozzle

Lightweight Docker log viewer.

### Install

Add to your `docker-compose.yml`:

```yaml
services:
  dozzle:
    image: amir20/dozzle:latest
    container_name: dozzle
    restart: unless-stopped
    ports:
      - "8080:8080"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
```

### Access

Open http://scion-pi:8080 to view real-time logs.

---

## Watchtower (Auto-Updates)

Automatically update Docker containers.

### Install

```bash
docker run -d \
  --name watchtower \
  --restart=always \
  -v /var/run/docker.sock:/var/run/docker.sock \
  containrrr/watchtower \
  --cleanup \
  --schedule "0 4 * * *"
```

This checks for updates daily at 4 AM.

### Options

```bash
# Update specific containers only
containrrr/watchtower scion-sync

# Send notifications (example with Slack)
-e WATCHTOWER_NOTIFICATIONS=slack \
-e WATCHTOWER_NOTIFICATION_SLACK_HOOK_URL="https://hooks.slack.com/..."
```

---

## Uptime Monitoring with Uptime Kuma

Self-hosted uptime monitoring.

### Install

```bash
docker run -d \
  --name uptime-kuma \
  --restart=always \
  -p 3001:3001 \
  -v uptime-kuma:/app/data \
  louislam/uptime-kuma:1
```

### Access

Open http://scion-pi:3001 and configure monitors for:
- Scion Sync health endpoint
- Other services

---

## External SSD Setup

Use an SSD for better performance and longevity.

### Find the Drive

```bash
lsblk
# Look for your SSD (e.g., sda)
```

### Format (if new)

```bash
sudo mkfs.ext4 /dev/sda1
```

### Mount

```bash
sudo mkdir -p /mnt/ssd
sudo mount /dev/sda1 /mnt/ssd
```

### Persistent Mount

Get the UUID:
```bash
sudo blkid /dev/sda1
```

Add to `/etc/fstab`:
```bash
UUID=your-uuid-here /mnt/ssd ext4 defaults,noatime 0 2
```

### Move Docker to SSD

```bash
sudo systemctl stop docker
sudo mv /var/lib/docker /mnt/ssd/
sudo ln -s /mnt/ssd/docker /var/lib/docker
sudo systemctl start docker
```

---

## Network UPS Tools (NUT)

For UPS monitoring and safe shutdown.

### Install

```bash
sudo apt install nut
```

### Configure

Edit `/etc/nut/ups.conf`:
```ini
[myups]
    driver = usbhid-ups
    port = auto
```

Edit `/etc/nut/nut.conf`:
```ini
MODE=standalone
```

### Start

```bash
sudo systemctl enable --now nut-server nut-monitor
```

### Check Status

```bash
upsc myups
```

---

## Fail2Ban (Security)

Protect against brute force attacks.

### Install

```bash
sudo apt install fail2ban
```

### Configure for SSH

```bash
sudo tee /etc/fail2ban/jail.local << 'EOF'
[sshd]
enabled = true
port = ssh
filter = sshd
logpath = /var/log/auth.log
maxretry = 3
bantime = 3600
EOF
```

### Start

```bash
sudo systemctl enable --now fail2ban
```

### Check Status

```bash
sudo fail2ban-client status sshd
```

---

## Cron Jobs for Maintenance

### Weekly Cleanup

```bash
crontab -e
```

Add:
```bash
# Clean Docker weekly
0 3 * * 0 docker system prune -f

# Reboot monthly (optional)
0 4 1 * * sudo reboot

# Update system weekly
0 2 * * 0 sudo apt update && sudo apt upgrade -y
```

---

## Quick Reference

| Tool | Port | Purpose |
|------|------|---------|
| Scion Sync | 3000 | Vault synchronization |
| Portainer | 9000 | Docker management |
| Dozzle | 8080 | Log viewer |
| Uptime Kuma | 3001 | Uptime monitoring |
| Glances | 61208 | System monitoring |

All ports should be restricted to Tailscale network for security:

```bash
sudo ufw allow from 100.64.0.0/10 to any port 3000,8080,9000,3001,61208
```
