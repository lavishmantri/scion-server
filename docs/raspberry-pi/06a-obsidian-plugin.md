# Obsidian Plugin Setup

Connect your Obsidian vault to the Scion Sync server running on your Raspberry Pi.

## Prerequisites

- Scion Sync server running on Raspberry Pi ([see deployment guide](./05-scion-deployment.md))
- Server accessible via local network or Tailscale ([see Tailscale setup](./03-tailscale.md))
- Obsidian installed on your device
- Server URL known (e.g., `http://scion-pi.local:3000`)

## Plugin Installation

### Manual Installation

1. **Download or build the plugin**:
   ```bash
   # On your development machine
   cd /path/to/scion/obsidian-plugin
   npm install
   npm run build
   ```

2. **Copy to Obsidian plugins directory**:

   The plugin files need to go in your vault's plugins folder:
   ```
   YourVault/.obsidian/plugins/scion-sync/
   ```

   Copy these files from the build:
   - `main.js`
   - `manifest.json`
   - `styles.css`

3. **Enable the plugin**:
   - Open Obsidian
   - Go to Settings → Community plugins
   - Turn off "Restricted mode" if enabled
   - Click "Browse" and find "Scion Sync" in the list
   - Or refresh and enable "Scion Sync" in installed plugins

## Configuration

### 1. Open Plugin Settings

- Settings → Community plugins → Scion Sync → Options
- Or click the Scion status in the status bar

### 2. Configure Server URL

**This is the most important setting** - it tells the plugin where your Scion server is located.

#### Option A: Local Network Access

If accessing the Pi on the same network:
```
http://scion-pi.local:3000
```

Or use the Pi's IP address:
```
http://192.168.1.100:3000
```

To find your Pi's IP:
```bash
# On the Raspberry Pi
hostname -I
```

#### Option B: Tailscale Access (Recommended)

If using Tailscale for remote access:
```
http://scion-pi:3000
```

Or use the Tailscale IP:
```
http://100.x.y.z:3000
```

To find your Pi's Tailscale IP:
```bash
# On the Raspberry Pi
tailscale ip -4
```

### 3. Configure Sync Settings

| Setting | Default | Recommended | Description |
|---------|---------|-------------|-------------|
| **Sync Interval** | 30s | 30-60s | How often to check for server changes. Lower = more responsive, higher = better battery life |
| **Typing Debounce** | 3s | 3-5s | Delay after you stop typing before syncing. Prevents excessive syncs while actively editing |
| **Auto-sync** | On | On | Enable automatic background syncing. Disable only for manual-only sync |
| **Sync on Startup** | On | On | Perform full sync when Obsidian opens. Ensures you start with latest content |
| **Conflict Mode** | Merge | Merge | How to handle conflicts when both local and server have changes |

### 4. Conflict Resolution Modes

Choose how the plugin handles conflicts:

| Mode | Behavior | Best For |
|------|----------|----------|
| **Merge** | Automatically merges changes with conflict markers if needed | Most users - handles most conflicts automatically |
| **Ask** | Shows a modal for each conflict, lets you choose | Users who want full control over conflicts |
| **Local** | Always keeps your local version | Single-device use or when local is source of truth |
| **Remote** | Always keeps server version | Multiple devices where server is authoritative |

**Conflict markers** (when merge fails):
```markdown
<<<<<<< Local
Your local changes
=======
Server changes
>>>>>>> Remote
```

## First Sync

### Trigger Initial Sync

After configuring the server URL:

1. **Automatic sync** (if enabled):
   - Plugin automatically syncs on startup
   - Watch the status bar for progress

2. **Manual sync**:
   - Click the Scion ribbon icon (left sidebar)
   - Or use command palette: `Ctrl/Cmd+P` → "Scion: Sync Now"
   - Or click status bar → "Sync Now" button

### What to Expect

During first sync:
- Status bar shows "Scion: Syncing..."
- All vault files are uploaded to server
- Takes longer than subsequent syncs
- You'll see a success notice when complete

Status bar will show:
- **"Scion: Ready"** - Plugin loaded, waiting
- **"Scion: Syncing..."** - Sync in progress (gray indicator)
- **"Scion: Synced"** - Sync successful (green indicator, fades after 3s)
- **"Scion: Error"** - Sync failed (red indicator with error message)

## Status Indicators

### Status Bar (Bottom Right)

Click the status text to open sync status modal with:
- Number of tracked files
- Last sync commit ID
- Pending conflicts (if any)
- "Sync Now" button

### Ribbon Icon (Left Sidebar)

The Scion icon provides quick access:
- Click to trigger manual sync
- Visual feedback during sync

### Commands

Access via command palette (`Ctrl/Cmd+P`):
- **Scion: Sync Now** - Trigger manual sync
- **Scion: Show Status** - Open status modal

## Connection Testing

### Before Configuring Plugin

Test that the server is reachable:

1. **Health check via browser**:

   Open in your browser:
   ```
   http://scion-pi.local:3000/health
   ```

   Should return:
   ```json
   {"status":"ok"}
   ```

2. **From command line**:
   ```bash
   curl http://scion-pi.local:3000/health
   ```

### Testing Different Connection Methods

| Method | URL | When to Use |
|--------|-----|-------------|
| Local hostname | `http://scion-pi.local:3000` | Same WiFi network |
| Local IP | `http://192.168.1.100:3000` | Same network, hostname not working |
| Tailscale hostname | `http://scion-pi:3000` | Remote access via Tailscale |
| Tailscale IP | `http://100.x.y.z:3000` | Remote access, hostname not working |

## Troubleshooting

### Cannot Connect to Server

**Error**: "Failed to fetch" or "Network request failed"

**Solutions**:

1. **Verify server is running**:
   ```bash
   # On Raspberry Pi
   docker compose ps
   # Should show scion-sync as "Up"
   ```

2. **Test health endpoint**:
   ```bash
   curl http://localhost:3000/health
   ```

   If this works but plugin doesn't connect, it's likely a network/firewall issue.

3. **Check firewall** (on Pi):
   ```bash
   # Ensure port 3000 is accessible
   sudo ss -tuln | grep 3000
   ```

4. **Verify network connectivity**:
   - Can you ping the Pi? `ping scion-pi.local`
   - Are you on the same network?
   - Is Tailscale running if using Tailscale URL?

5. **Try alternative URLs**:
   - If `.local` doesn't work, try IP address
   - If local doesn't work, try Tailscale
   - Ensure `http://` prefix is included

### Plugin Not Appearing in Obsidian

**Solutions**:

1. **Verify plugin files are in correct location**:
   ```
   YourVault/.obsidian/plugins/scion-sync/
   ├── main.js
   ├── manifest.json
   └── styles.css
   ```

2. **Check manifest.json is valid**:
   - Must be valid JSON
   - Should have `id: "scion-sync"`

3. **Restart Obsidian completely**:
   - Quit Obsidian (not just close window)
   - Reopen Obsidian

4. **Check console for errors**:
   - View → Toggle Developer Tools → Console
   - Look for errors related to scion-sync

### Sync Not Triggering Automatically

**Solutions**:

1. **Verify auto-sync is enabled**:
   - Settings → Scion Sync → Auto-sync toggle should be ON

2. **Check poll interval**:
   - If set too high (>60s), sync feels slow
   - Try lowering to 30s for testing

3. **Check status bar**:
   - If it shows "Error", click for details
   - Error message will indicate the problem

4. **Manual sync test**:
   - Try manual sync: click ribbon icon
   - If manual works but auto doesn't, it's a polling issue
   - Check console for errors

### Conflicts Not Resolving

**Symptoms**: Conflict markers appearing frequently or incorrectly

**Solutions**:

1. **Understand your conflict mode**:
   - **Merge mode**: Creates conflict markers when auto-merge fails
   - **Ask mode**: Shows modal for every conflict
   - **Local/Remote**: Automatically chooses one side

2. **Check for sync timing issues**:
   - If editing on multiple devices simultaneously, conflicts are expected
   - Increase debounce interval to reduce rapid syncs while typing

3. **Review conflict markers manually**:
   ```markdown
   <<<<<<< Local
   Your changes
   =======
   Server changes
   >>>>>>> Remote
   ```

   Edit to keep desired content and remove markers.

4. **Switch conflict mode if needed**:
   - Try "Ask" mode to manually review each conflict
   - Or "Local"/"Remote" to automatically prefer one side

### High Battery Usage (Mobile)

**Solutions**:

1. **Increase poll interval**:
   - Default 30s is good for desktop
   - Try 60-120s for mobile to reduce battery drain

2. **Disable sync on startup** (mobile):
   - Only sync when you open a note
   - Reduces initial battery hit

3. **Use manual sync only**:
   - Disable auto-sync
   - Sync manually when needed via ribbon icon

## Advanced Configuration

### Multiple Vaults

Each Obsidian vault syncs independently:

- Vault name is auto-detected: `app.vault.getName()`
- Server creates separate directories: `/vault/{VaultName}/`
- Configure plugin separately in each vault
- Can point to same server or different servers

**Example**:
- Work vault → `http://scion-pi.local:3000`
- Personal vault → `http://other-server:3000`

### Optimizing Poll Interval

| Use Case | Recommended Interval |
|----------|---------------------|
| Desktop, single user | 30s |
| Desktop, multiple devices | 15-30s |
| Mobile, frequent use | 60s |
| Mobile, occasional use | 120s |
| Manual sync only | Disable auto-sync |

Lower intervals = more responsive but more battery/network usage.

### Understanding Sync State

The plugin tracks state in `.obsidian/plugins/scion-sync/data.json`:

```json
{
  "settings": {
    "serverUrl": "http://scion-pi.local:3000",
    "pollInterval": 30,
    "autoSync": true,
    "syncOnStartup": true,
    "conflictMode": "merge",
    "debounceInterval": 3
  },
  "syncState": {
    "Note.md": {
      "hash": "abc123...",
      "commit": "def456..."
    }
  }
}
```

- **hash**: SHA-256 of file content (detects local changes)
- **commit**: Server-assigned version ID (detects server changes)

### Security Considerations

**No authentication**: The plugin doesn't use authentication. Security relies on:

1. **Network isolation**: Server only accessible on local network
2. **Tailscale**: Encrypted VPN for remote access
3. **No public exposure**: Don't expose port 3000 to internet

**Best practices**:
- Use Tailscale for remote access
- Don't port-forward 3000 on your router
- Keep server behind firewall

### API Endpoints (For Debugging)

The plugin uses these endpoints:

| Endpoint | Purpose |
|----------|---------|
| `GET /vault/{name}/manifest` | Fetch all tracked files |
| `GET /vault/{name}/status?since={commit}` | Check for changes |
| `GET /vault/{name}/file/{path}` | Download file |
| `POST /vault/{name}/sync` | Upload/sync file |
| `DELETE /vault/{name}/file/{path}` | Delete file |

You can test these with `curl` for debugging:

```bash
# Get manifest
curl http://scion-pi.local:3000/vault/MyVault/manifest

# Health check
curl http://scion-pi.local:3000/health
```

## Next Steps

Your Obsidian vault is now synced to your Raspberry Pi!

Continue with:
- [06 - Optional Tools](./06-optional-tools.md) - Monitoring and management tools
- [07 - Hotspot Mode](./07-hotspot-mode.md) - Offline sync via Pi WiFi hotspot

## Quick Reference

### Essential Settings

```
Server URL: http://scion-pi.local:3000  (or Tailscale URL)
Poll Interval: 30s (desktop) / 60s (mobile)
Debounce: 3s
Auto-sync: ON
Sync on Startup: ON
Conflict Mode: Merge
```

### Common Commands

```bash
# Check server status
curl http://scion-pi.local:3000/health

# Check if sync is working (look for your vault)
curl http://scion-pi.local:3000/vault/MyVault/manifest
```

### Status Bar States

- **Ready**: Idle, waiting for changes
- **Syncing...**: Sync in progress
- **Synced**: Sync completed successfully
- **Error**: Sync failed (click for details)
