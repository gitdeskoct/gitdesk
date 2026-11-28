#!/usr/bin/env bash
# Usage: smoke-linux.sh <path to the unpacked gitdesk binary>
set -euo pipefail

app=$(realpath -e "${1:?expected path to the packaged gitdesk binary}")
package=$(dirname "$app")
test -x "$app" && test -f "$package/resources/app.asar" || {
  printf 'Not an unpacked gitdesk package: %s\n' "$app" >&2
  exit 1
}
helper=$(dirname "$(realpath "$0")")/smoke-mcp.py

# Only the package and the driver are mounted beside the system runtime. The home, X display,
# clipboard, D-Bus and MCP socket live in this namespace; its processes and tmpfs die together.
exec timeout --kill-after=5s 120s bwrap --unshare-all --die-with-parent --new-session \
  --ro-bind /usr /usr --ro-bind /etc /etc --ro-bind /lib /lib --ro-bind-try /lib64 /lib64 \
  --symlink usr/bin /bin --dev /dev --proc /proc --tmpfs /tmp --perms 01777 --dir /tmp/.X11-unix \
  --ro-bind "$package" '/packaged gitdesk' --ro-bind "$helper" /smoke-mcp.py \
  --perms 0700 --dir /tmp/home --perms 0700 --dir /tmp/runtime --chdir /tmp/home \
  --clearenv --setenv PATH /usr/bin:/bin --setenv LANG C.UTF-8 \
  --setenv HOME /tmp/home --setenv XDG_RUNTIME_DIR /tmp/runtime --setenv GDK_BACKEND x11 \
  xvfb-run -a dbus-run-session -- python3 -I -u /smoke-mcp.py "/packaged gitdesk/$(basename "$app")"
