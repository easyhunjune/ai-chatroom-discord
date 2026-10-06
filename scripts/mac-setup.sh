#!/bin/sh
# One-time (and re-runnable) setup on macOS: npm install, PNG avatars for the Discord
# webhooks, and a per-user LaunchAgent that starts the room at login and restarts it if it
# exits. Run from anywhere: sh scripts/mac-setup.sh
set -e
DIR=$(cd "$(dirname "$0")/.." && pwd)
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
NODE=$(command -v node)
LABEL="com.$(id -un).ai-chatroom"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

cd "$DIR"
npm install --omit=dev --no-audit --no-fund

# Discord avatars must be png/jpg/gif; the room's pictures are webp.
for f in public/avatars/*.webp; do
  png="${f%.webp}.png"
  [ -f "$png" ] || sips -s format png "$f" --out "$png" >/dev/null
done

[ -f config.json ] || cp config.example.json config.json
[ -f .env ] || { cp .env.example .env; chmod 600 .env; }
mkdir -p data/logs

cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$DIR/server.mjs</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>$DIR/data/logs/server.out.log</string>
  <key>StandardErrorPath</key><string>$DIR/data/logs/server.err.log</string>
</dict>
</plist>
PL

TARGET="gui/$(id -u)/$LABEL"
if launchctl print "$TARGET" >/dev/null 2>&1; then
  launchctl bootout "$TARGET" 2>/dev/null || true
  # bootout returns before the old agent is gone, and bootstrap fails until it is.
  i=0
  while launchctl print "$TARGET" >/dev/null 2>&1 && [ $i -lt 30 ]; do sleep 0.5; i=$((i + 1)); done
fi
i=0
until launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; do
  i=$((i + 1))
  if [ $i -ge 5 ]; then launchctl bootstrap "gui/$(id -u)" "$PLIST"; break; fi # last try shows the error
  sleep 1
done
echo "LaunchAgent $LABEL installed. Logs: $DIR/data/logs/server.out.log"
echo "Restart after editing config.json or .env:  launchctl kickstart -k gui/$(id -u)/$LABEL"
