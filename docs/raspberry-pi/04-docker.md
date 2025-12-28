# Docker Installation

Docker allows running Scion Sync in an isolated container with all dependencies bundled.

## Important Notes

- **64-bit OS recommended**: Use Raspberry Pi OS 64-bit (arm64) for best Docker support
- **32-bit deprecation**: Docker Engine v28 is the last version supporting 32-bit (armhf). Starting with v29, 32-bit is unsupported
- **Minimum RAM**: 4GB+ recommended for running multiple containers

## Installation

### One-Line Install (Recommended)

```bash
curl -fsSL https://get.docker.com | sh
```

The script auto-detects your Pi's architecture and installs the correct version.

### Add User to Docker Group

This allows running Docker without `sudo`:

```bash
sudo usermod -aG docker $USER
```

**CRITICAL:** You MUST completely log out and log back in for this to take effect. Simply opening a new terminal or running `su` will NOT work:

```bash
exit
# Then SSH back in
ssh pi@scion-pi.local
```

**Verify group membership after logging back in:**

```bash
# This should show "docker" in the list
groups
```

If you don't see `docker` in the groups list, the logout/login didn't work properly. Try:
- Closing all SSH sessions completely
- Logging out from the physical terminal if using one
- Rebooting the Pi: `sudo reboot`

### Verify Installation

After logging back in and confirming group membership:

```bash
# Check Docker version
docker --version

# Check Docker Compose version
docker compose version

# Test Docker works without sudo
docker run hello-world
```

If you still get "permission denied" errors, see the [Permission Denied](#permission-denied) troubleshooting section.

## Configuration

### Enable Docker on Boot

Docker should auto-enable, but verify:

```bash
sudo systemctl enable docker
sudo systemctl is-enabled docker
```

### Configure Docker Logging

Prevent logs from filling up the SD card:

```bash
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json << 'EOF'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  },
  "storage-driver": "overlay2"
}
EOF

sudo systemctl restart docker
```

### Move Docker Data (Optional)

If using an external SSD for more storage:

```bash
# Stop Docker
sudo systemctl stop docker

# Move data
sudo mv /var/lib/docker /mnt/ssd/docker
sudo ln -s /mnt/ssd/docker /var/lib/docker

# Start Docker
sudo systemctl start docker
```

## Useful Docker Commands

### Container Management

```bash
# List running containers
docker ps

# List all containers (including stopped)
docker ps -a

# Stop a container
docker stop container-name

# Remove a container
docker rm container-name

# View container logs
docker logs container-name
docker logs -f container-name  # Follow logs
```

### Image Management

```bash
# List images
docker images

# Remove an image
docker rmi image-name

# Remove unused images
docker image prune

# Remove all unused data
docker system prune -a
```

### Docker Compose Commands

```bash
# Start services
docker compose up -d

# Stop services
docker compose down

# View logs
docker compose logs -f

# Rebuild and restart
docker compose up -d --build

# Check status
docker compose ps
```

## Resource Limits

### Limit Container Memory

For Raspberry Pi with limited RAM, add to `docker-compose.yml`:

```yaml
services:
  scion-sync:
    # ... other config ...
    deploy:
      resources:
        limits:
          memory: 512M
        reservations:
          memory: 256M
```

### Monitor Resource Usage

```bash
# Real-time stats
docker stats

# One-time snapshot
docker stats --no-stream
```

## Troubleshooting

### Docker Won't Start

```bash
# Check status
sudo systemctl status docker

# View logs
sudo journalctl -u docker -f

# Restart
sudo systemctl restart docker
```

### Permission Denied

If you see "permission denied" errors:

```bash
# Verify group membership
groups

# If docker group missing, re-add and re-login
sudo usermod -aG docker $USER
exit
# SSH back in
```

### Disk Space Issues

```bash
# Check disk usage
df -h

# Clean up Docker
docker system prune -a

# Remove old images
docker image prune -a
```

### Container Can't Access Network

```bash
# Restart Docker
sudo systemctl restart docker

# Check Docker networks
docker network ls
docker network inspect bridge
```

## Health Checks

### Verify Docker is Healthy

```bash
# System info
docker info

# Check for errors
docker info 2>&1 | grep -i error
```

### Automated Health Check Script

Create `/home/pi/check-docker.sh`:

```bash
#!/bin/bash
if ! docker info > /dev/null 2>&1; then
    echo "Docker is not running, restarting..."
    sudo systemctl restart docker
fi
```

Add to crontab:
```bash
crontab -e
# Add:
*/5 * * * * /home/pi/check-docker.sh
```

## Next Steps

Docker is now installed and configured.

Continue to:
- [05 - Scion Deployment](./05-scion-deployment.md) - Deploy Scion Sync
