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
mkdir -p /home/lavishmantri/scion-vault
# Set ownership for container user (uid 1001)
sudo chown -R 1001:1001 /home/lavishmantri/scion-vault
```

**Why uid 1001?** The container runs as the `scion` user (uid 1001) for security. The vault directory needs to be writable by this user.

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
VAULT_HOST_PATH=/home/lavishmantri/scion-vault
```

**Note:** Replace `lavishmantri` with your actual username on the Pi.

### Build and Start

```bash
docker compose up -d --build
```

First build takes a few minutes on Raspberry Pi.

**Auto-start is enabled by default!** The container will automatically start on boot thanks to the `restart: unless-stopped` policy in docker-compose.yml.

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

## Auto-Start Configuration

### Method 1: Docker Compose Restart Policy (Enabled by Default)

The `docker-compose.yml` already includes `restart: unless-stopped`, which means:
- Container starts automatically when Docker daemon starts
- Container restarts if it crashes
- Container only stops when explicitly stopped with `docker compose down` or `docker stop`

**This is the recommended approach** - no additional setup needed!

To verify:
```bash
# Check restart policy
docker inspect scion-sync | grep -i restart

# Test by rebooting
sudo reboot
# After reboot, check container is running
docker compose ps
```

### Method 2: Systemd Service (Optional)

For additional control via systemd (not required if using Method 1):

```bash
sudo cp scion-sync.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable scion-sync
```

Manage the service:
```bash
# Start
sudo systemctl start scion-sync

# Stop
sudo systemctl stop scion-sync

# Restart
sudo systemctl restart scion-sync

# Status
sudo systemctl status scion-sync

# View logs
sudo journalctl -u scion-sync -f
```

**Note:** Using both methods simultaneously is fine. The systemd service will use `docker compose` which respects the restart policy.

## Configure Obsidian Plugin

Your server is now running! Next, install and configure the Obsidian plugin to connect your vault.

**Quick connection URLs:**
- Same network: `http://scion-pi.local:3000`
- Tailscale (recommended): `http://scion-pi:3000`
- Tailscale IP: `http://100.x.y.z:3000`

For complete plugin installation and configuration instructions, see:
**[06a - Obsidian Plugin Setup](./06a-obsidian-plugin.md)**

The guide covers:
- Plugin installation steps
- Detailed configuration options
- Connection testing and troubleshooting
- Sync settings and conflict resolution

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

**Error**: `EACCES: permission denied, mkdir '/data/vault/...'`

This means the container can't write to the vault directory. Fix with:

```bash
# Fix vault directory permissions (replace with your username)
sudo chown -R 1001:1001 /home/lavishmantri/scion-vault

# Restart container
docker compose restart
```

**Why 1001?** The container runs as user `scion` (uid 1001) for security. The vault directory must be owned by this user.

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

Continue with:
- [06a - Obsidian Plugin Setup](./06a-obsidian-plugin.md) - Connect your Obsidian vault
- [03 - Tailscale](./03-tailscale.md) - Set up remote access (if not done yet)
- [06 - Optional Tools](./06-optional-tools.md) - Monitoring and management tools
