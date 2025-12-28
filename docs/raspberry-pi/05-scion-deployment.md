# Scion Sync Deployment

Deploy the Scion Sync server on your Raspberry Pi.

## Prerequisites

- [Docker installed](./04-docker.md)
- [Tailscale configured](./03-tailscale.md) (recommended)

## Quick Deploy

### Clone the Repository

```bash
cd ~
git clone <your-repo-url> scion
cd scion/server
```

### Create Vault Directory

```bash
mkdir -p /home/pi/scion-vault
```

### Configure Environment

```bash
cp .env.example .env
```

Edit `.env` if needed:
```bash
nano .env
```

Default configuration:
```bash
PORT=3000
LOG_LEVEL=info
VAULT_HOST_PATH=/home/pi/scion-vault
```

### Build and Start

```bash
docker compose up -d --build
```

First build takes a few minutes on Raspberry Pi.

### Verify

```bash
# Check container is running
docker compose ps

# Check logs
docker compose logs

# Test health endpoint
curl http://localhost:3000/health
```

Expected response: `{"status":"ok"}`

## Configure Auto-Start

### Install Systemd Service

```bash
sudo cp scion-sync.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable scion-sync
```

### Manage the Service

```bash
# Start
sudo systemctl start scion-sync

# Stop
sudo systemctl stop scion-sync

# Restart
sudo systemctl restart scion-sync

# Status
sudo systemctl status scion-sync
```

## Configure Obsidian Plugin

In Obsidian, install the Scion Sync plugin and configure:

**Server URL:**
```
# If on same network
http://scion-pi.local:3000

# Via Tailscale (recommended)
http://scion-pi:3000

# Or using Tailscale IP
http://100.x.y.z:3000
```

**Vault Name:** Choose a name for your vault (e.g., `MyNotes`)

## Updating

### Pull Latest Changes

```bash
cd ~/scion/server
git pull
```

### Rebuild and Restart

```bash
docker compose up -d --build
```

### Zero-Downtime Update (Advanced)

```bash
# Build new image
docker compose build

# Restart with new image
docker compose up -d
```

## Backup

### Backup Vault Data

The vault data is stored at `/home/pi/scion-vault`. Back it up regularly:

```bash
# Create backup
tar -czf ~/scion-backup-$(date +%Y%m%d).tar.gz /home/pi/scion-vault

# Copy to another machine via Tailscale
scp ~/scion-backup-*.tar.gz your-mac:~/backups/
```

### Automated Backup Script

Create `/home/pi/backup-scion.sh`:

```bash
#!/bin/bash
BACKUP_DIR="/home/pi/backups"
VAULT_DIR="/home/pi/scion-vault"
DATE=$(date +%Y%m%d_%H%M%S)

mkdir -p $BACKUP_DIR
tar -czf "$BACKUP_DIR/scion-$DATE.tar.gz" -C "$(dirname $VAULT_DIR)" "$(basename $VAULT_DIR)"

# Keep only last 7 backups
ls -t $BACKUP_DIR/scion-*.tar.gz | tail -n +8 | xargs -r rm
```

Add to crontab for daily backup:
```bash
crontab -e
# Add:
0 3 * * * /home/pi/backup-scion.sh
```

## Monitoring

### View Logs

```bash
# Follow logs
docker compose logs -f

# Last 100 lines
docker compose logs --tail 100
```

### Check Resource Usage

```bash
# Container stats
docker stats scion-sync

# System resources
htop
```

### Health Check

```bash
# Simple check
curl -s http://localhost:3000/health | jq

# With timing
time curl -s http://localhost:3000/health
```

## Troubleshooting

### Container Won't Start

```bash
# Check logs
docker compose logs

# Check container status
docker compose ps -a

# Try running interactively
docker compose up
```

### Permission Issues

```bash
# Fix vault directory permissions
sudo chown -R 1001:1001 /home/pi/scion-vault
```

### Port Already in Use

```bash
# Check what's using port 3000
sudo ss -tuln | grep 3000
sudo lsof -i :3000

# Change port in .env
PORT=3001
```

### Git Errors in Container

```bash
# Check git is working inside container
docker compose exec scion-sync git --version

# Check vault directory permissions
docker compose exec scion-sync ls -la /data/vault
```

### Reset Everything

```bash
# Stop and remove containers
docker compose down

# Remove images
docker compose down --rmi all

# Clear vault (WARNING: deletes all data!)
rm -rf /home/pi/scion-vault/*

# Rebuild
docker compose up -d --build
```

## Performance Tuning

### For Raspberry Pi 3

Add memory limit to prevent swapping:

```yaml
# In docker-compose.yml
services:
  scion-sync:
    deploy:
      resources:
        limits:
          memory: 256M
```

### For Raspberry Pi 4/5

You can allow more memory:

```yaml
services:
  scion-sync:
    deploy:
      resources:
        limits:
          memory: 512M
```

### Use SSD for Vault

For better performance, store vault on SSD:

```bash
# Mount SSD (example)
sudo mkdir -p /mnt/ssd
sudo mount /dev/sda1 /mnt/ssd

# Add to /etc/fstab for persistence
echo "/dev/sda1 /mnt/ssd ext4 defaults,noatime 0 2" | sudo tee -a /etc/fstab

# Update .env
VAULT_HOST_PATH=/mnt/ssd/scion-vault
```

## Next Steps

Your Scion Sync server is now running!

- Configure Obsidian plugin to connect
- Set up [Tailscale](./03-tailscale.md) for remote access
- Check [Optional Tools](./06-optional-tools.md) for monitoring
