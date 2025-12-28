# Tailscale Setup

Tailscale creates a secure VPN mesh network, allowing you to access your Pi from anywhere without exposing ports to the internet.

## Why Tailscale?

- **Secure**: WireGuard-based encryption
- **Simple**: No port forwarding or dynamic DNS needed
- **Reliable**: Works through NATs and firewalls
- **Free**: Up to 100 devices on the free plan

## Installation

### One-Line Install

```bash
curl -fsSL https://tailscale.com/install.sh | sh
```

### Manual Install (Alternative)

```bash
# Add Tailscale repository
curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.noarmor.gpg | sudo tee /usr/share/keyrings/tailscale-archive-keyring.gpg > /dev/null
curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.tailscale-keyring.list | sudo tee /etc/apt/sources.list.d/tailscale.list

# Install
sudo apt update
sudo apt install tailscale
```

## Authentication

### Start Tailscale

```bash
sudo tailscale up
```

This will print a URL. Open it in your browser to authenticate with your Tailscale account.

### Verify Connection

```bash
# Check status
tailscale status

# Get your Tailscale IP
tailscale ip -4
```

You should see something like `100.x.y.z`.

## Configuration Options

### Enable SSH via Tailscale

Access your Pi from anywhere using Tailscale SSH:

```bash
sudo tailscale up --ssh
```

Now you can SSH using the Tailscale hostname:
```bash
# From any device on your Tailnet
ssh pi@scion-pi
```

### Set a Stable Hostname

In the Tailscale admin console (https://login.tailscale.com/admin/machines):

1. Find your Pi
2. Click the three dots menu
3. Select "Edit machine name"
4. Set it to `scion-pi`

Now access via: `scion-pi.tailnet-name.ts.net`

### Accept DNS (Optional)

Use Tailscale's MagicDNS:

```bash
sudo tailscale up --accept-dns
```

### Advertise as Exit Node (Optional)

Allow other devices to route traffic through your Pi:

```bash
sudo tailscale up --advertise-exit-node
```

Then approve it in the admin console.

## Firewall Configuration

### Restrict Scion to Tailscale Only

For maximum security, only allow Scion access via Tailscale:

```bash
# Install ufw if not present
sudo apt install ufw

# Default policies
sudo ufw default deny incoming
sudo ufw default allow outgoing

# Allow SSH from anywhere (fallback)
sudo ufw allow ssh

# Allow Scion ONLY from Tailscale network
sudo ufw allow from 100.64.0.0/10 to any port 3000

# Enable firewall
sudo ufw enable
```

Check status:
```bash
sudo ufw status verbose
```

## Auto-Start on Boot

Tailscale automatically enables itself on boot. Verify:

```bash
sudo systemctl status tailscaled
sudo systemctl is-enabled tailscaled
```

## Accessing Scion via Tailscale

From any device on your Tailnet:

```bash
# Using Tailscale IP
curl http://100.x.y.z:3000/health

# Using MagicDNS hostname
curl http://scion-pi:3000/health

# Using full domain
curl http://scion-pi.tailnet-name.ts.net:3000/health
```

### Configure Obsidian Plugin

In Obsidian settings, set the server URL to:
```
http://scion-pi:3000
```

Or use the Tailscale IP: `http://100.x.y.z:3000`

## Troubleshooting

### Check Tailscale Status

```bash
tailscale status
tailscale netcheck
```

### View Logs

```bash
sudo journalctl -u tailscaled -f
```

### Re-authenticate

```bash
sudo tailscale logout
sudo tailscale up
```

### Connection Issues

```bash
# Check if tailscaled is running
sudo systemctl status tailscaled

# Restart if needed
sudo systemctl restart tailscaled

# Check network
tailscale ping scion-pi
```

## Security Best Practices

1. **Use Tailscale SSH** instead of exposing port 22
2. **Restrict Scion to Tailscale** using firewall rules
3. **Enable key expiry** in Tailscale admin console
4. **Use ACLs** to control access between devices

### Example ACL (in Tailscale admin)

```json
{
  "acls": [
    {
      "action": "accept",
      "src": ["tag:trusted"],
      "dst": ["tag:server:*"]
    }
  ],
  "tagOwners": {
    "tag:trusted": ["your-email@example.com"],
    "tag:server": ["your-email@example.com"]
  }
}
```

## Next Steps

Your Pi is now securely accessible from anywhere via Tailscale.

Continue to:
- [04 - Docker](./04-docker.md) - Install Docker
- [05 - Scion Deployment](./05-scion-deployment.md) - Deploy Scion Sync
