# Flashing Raspberry Pi OS on Mac

## Option 1: Raspberry Pi Imager 2.0 (Recommended)

The official tool with a new wizard interface (version 2.0.3, December 2025).

### Install

```bash
brew install --cask raspberry-pi-imager
```

Or download from: https://www.raspberrypi.com/software/

### Steps

1. **Insert SD card** into your Mac

2. **Open Raspberry Pi Imager** - New wizard-style interface in 2.0

3. **Choose Device**
   - Select your Raspberry Pi model (Pi 4, Pi 5, etc.)

4. **Choose OS**
   - Select "Raspberry Pi OS (64-bit)" for Pi 4/5
   - Select "Raspberry Pi OS Lite (64-bit)" for headless server (no desktop)
   - **Recommended: Lite version** for server use
   - Latest: Based on Debian 13 "Trixie" (November 2025)

5. **Choose Storage**
   - Select your SD card
   - Imager 2.0.3 has improved counterfeit/faulty storage detection

6. **Edit Settings** (click "Edit Settings" in the wizard)

   **General tab:**
   - Set hostname: `scion-pi` (or your preference)
   - Set username and password: `pi` / `<your-password>`
   - Configure wireless LAN (primary WiFi)
   - Set locale settings

   **Services tab:**
   - Enable SSH
   - Use password authentication (or add your public key)

   **New in 2.0:**
   - Pre-configure Raspberry Pi Connect (optional)
   - Improved accessibility options

7. **Write**
   - Click "Write" and confirm
   - Wait for write and verification to complete
   - Faster writes in Imager 2.0.3

### Verify

After writing, the SD card will be ejected. Re-insert it to verify:

```bash
# Check the boot partition is readable
ls /Volumes/bootfs
```

You should see files like `config.txt`, `cmdline.txt`, etc.

---

## Option 2: Manual Flashing with dd

For advanced users who prefer command line.

### Download OS Image

```bash
# Download Raspberry Pi OS Lite (64-bit) - Trixie based
# Check https://www.raspberrypi.com/software/operating-systems/ for latest URL
curl -L -o raspios.img.xz https://downloads.raspberrypi.com/raspios_lite_arm64/images/raspios_lite_arm64-latest/raspios-trixie-arm64-lite.img.xz

# Extract
xz -d raspios.img.xz
```

### Find SD Card Device

```bash
# List disks before inserting SD card
diskutil list

# Insert SD card, then list again
diskutil list

# Note the new disk (e.g., /dev/disk4)
```

### Flash

```bash
# Replace diskN with your SD card disk number
DISK=/dev/disk4

# Unmount (not eject)
diskutil unmountDisk $DISK

# Flash (use rdisk for faster write)
sudo dd if=raspios.img of=/dev/r${DISK#/dev/} bs=4m status=progress

# Eject when done
diskutil eject $DISK
```

### Enable SSH Manually

After flashing, re-insert the SD card:

```bash
# Create empty ssh file to enable SSH on first boot
touch /Volumes/bootfs/ssh
```

### Configure WiFi Manually

Create the network configuration file:

```bash
cat > /Volumes/bootfs/custom.toml << 'EOF'
# Raspberry Pi first-boot configuration

[system]
hostname = "scion-pi"

[user]
name = "pi"
# Generate password hash: echo 'mypassword' | openssl passwd -6 -stdin
password = "$6$rounds=656000$xyz..."
password_encrypted = true

[ssh]
enabled = true
password_authentication = true

[wlan]
ssid = "Your-WiFi-SSID"
password = "Your-WiFi-Password"
country = "US"
EOF
```

**Note:** For Trixie (Debian 13) and Bookworm (Debian 12), the configuration format has changed. The Raspberry Pi Imager handles this automatically, which is why it's recommended.

---

## Option 3: Using balenaEtcher

A simple cross-platform flashing tool.

### Install

```bash
brew install --cask balenaetcher
```

Or download from: https://etcher.balena.io/

### Steps

1. Open balenaEtcher
2. Select the downloaded `.img` or `.img.xz` file
3. Select your SD card
4. Click "Flash!"

**Note:** balenaEtcher doesn't have built-in Pi configuration. You'll need to enable SSH and configure WiFi manually (see Option 2).

---

## Troubleshooting

### SD card not recognized

```bash
# Check if Mac sees the card
diskutil list

# Try a different USB adapter or SD card slot
```

### Write fails

- Ensure SD card isn't write-protected (physical switch)
- Try a different SD card
- Use a high-quality card (SanDisk, Samsung recommended)

### Can't connect after boot

- Wait 1-2 minutes for first boot to complete
- Ensure SSH was enabled
- Check WiFi credentials are correct
- Try Ethernet if WiFi isn't working

---

## Next Steps

Once the SD card is ready:

1. Insert it into your Raspberry Pi
2. Connect power
3. Wait 1-2 minutes for first boot
4. Continue to [02 - Initial Setup](./02-initial-setup.md)
