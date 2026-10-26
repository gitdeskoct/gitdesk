#!/usr/bin/env bash
# Starts a packaged gitdesk under a virtual display and waits for main to log that its window loaded.
# Usage: smoke-linux.sh <path to the gitdesk binary>
set -euo pipefail

app="$1"
log="$HOME/.config/gitdesk/logs/main.log"
rm -f "$log"

# Its own process group, so stopping it also stops Xvfb and every Electron helper.
setsid xvfb-run -a "$app" &
group=$!
stop() { kill -TERM -- "-$group" 2>/dev/null || true; }

for _ in $(seq 1 60); do
  if grep -q 'window ready' "$log" 2>/dev/null; then
    echo "gitdesk started and loaded its window."
    stop
    exit 0
  fi
  if ! kill -0 "$group" 2>/dev/null; then
    break
  fi
  sleep 1
done

echo "::error::gitdesk did not log 'window ready' within 60 seconds."
cat "$log" 2>/dev/null || echo "(no log file at $log)"
stop
exit 1
