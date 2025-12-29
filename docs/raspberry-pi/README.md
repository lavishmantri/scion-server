# Raspberry Pi Setup Guide

Step-by-step guides for setting up a Raspberry Pi to run the Scion Sync server.

*Updated December 2025 for Raspberry Pi OS Trixie (Debian 13) and Imager 2.0*

## Prerequisites

- Raspberry Pi 4 or 5 (recommended) or Pi 3B+
- MicroSD card (32GB+ recommended)
- Power supply (USB-C for Pi 4/5)
- Mac for flashing the OS
- Network access (Ethernet or WiFi)

## Software Versions (as of December 2025)

| Software | Version |
|----------|---------|
| Raspberry Pi OS | Trixie (Debian 13) |
| Raspberry Pi Imager | 2.0.3 |
| Docker | 27.x (64-bit recommended) |
| NetworkManager | Default network manager |

## Guides

| Guide | Description |
|-------|-------------|
| [01 - Flashing OS](./01-flashing-os.md) | Burn Raspberry Pi OS to SD card on Mac |
| [02 - Initial Setup](./02-initial-setup.md) | First boot, SSH access, WiFi configuration |
| [03 - Tailscale](./03-tailscale.md) | Secure remote access via Tailscale VPN |
| [04 - Docker](./04-docker.md) | Install Docker and Docker Compose |
| [05 - Scion Deployment](./05-scion-deployment.md) | Deploy Scion Sync server |
| [06a - Obsidian Plugin](./06a-obsidian-plugin.md) | Install and configure Obsidian plugin |
| [06 - Optional Tools](./06-optional-tools.md) | Raspberry Pi Connect, monitoring, etc. |
| [07 - Hotspot Mode](./07-hotspot-mode.md) | Offline sync via Pi WiFi hotspot |

## Quick Start

If you're in a hurry, here's the minimal path:

```bash
# 1. Flash OS with SSH enabled (Guide 01)
# 2. SSH into Pi
ssh pi@raspberrypi.local

# 3. Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# 4. Install Tailscale
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# 5. Clone and run Scion
git clone <your-repo> ~/scion
cd ~/scion/server
mkdir -p /home/pi/scion-vault
cp .env.example .env
docker compose up -d
```

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    Raspberry Pi                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │              Docker Container                     │  │
│  │  ┌─────────────────────────────────────────────┐  │  │
│  │  │           Scion Sync Server                 │  │  │
│  │  │              (Port 3000)                    │  │  │
│  │  └─────────────────────────────────────────────┘  │  │
│  │                      │                            │  │
│  │              /data/vault (mount)                  │  │
│  └──────────────────────┼────────────────────────────┘  │
│                         │                               │
│              /home/pi/scion-vault                       │
│                  (persistent data)                      │
│                                                         │
│  ┌─────────────┐    ┌─────────────┐                     │
│  │  Tailscale  │    │    SSH      │                     │
│  │  (secure)   │    │  (local)    │                     │
│  └─────────────┘    └─────────────┘                     │
└─────────────────────────────────────────────────────────┘
           │                    │
           ▼                    ▼
    Remote Access          Local Access
    (any network)          (same network)
```
