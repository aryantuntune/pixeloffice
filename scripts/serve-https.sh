#!/usr/bin/env bash
# Serve PixelOffice over HTTPS on the LAN so mic/camera (calls) work.
# Single origin: Node (SERVE_CLIENT) serves client + API + WS on :2567;
# Caddy terminates TLS in front. See ./Caddyfile for details.
#
# Usage:
#   ./scripts/serve-https.sh            # https://<lan-ip>:8443  (no sudo)
#   PORT443=1 ./scripts/serve-https.sh  # https://<lan-ip>       (uses sudo for :443)
set -euo pipefail

# Caddy is OPTIONAL (Constitution: integrations never break zero-config dev).
# This script is the only thing that needs it; if it's missing, explain how to
# get it and point back to the plain HTTP dev path that always works.
if ! command -v caddy >/dev/null 2>&1; then
  cat >&2 <<'EOF'
[serve-https] Caddy is not installed — this HTTPS helper needs it.

  Install it:
    macOS:   brew install caddy
    Linux:   https://caddyserver.com/docs/install

Caddy is only required for LAN HTTPS (so mic/camera calls work on other
devices). The office itself does NOT need it:
  • Local dev (calls work on localhost):   npm run dev
  • Plain HTTP on the LAN (no calls):      SERVE_CLIENT=true npm run -w server start
EOF
  exit 1
fi

cd "$(dirname "$0")/.."

# Detect the primary LAN IP (macOS en0, fallback to first global v4).
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
if [ -z "${LAN_IP}" ]; then
  LAN_IP="$(ifconfig 2>/dev/null | awk '/inet /{print $2}' | grep -v '^127\.' | head -1 || true)"
fi
LAN_IP="${LAN_IP:-127.0.0.1}"

if [ "${PORT443:-0}" = "1" ]; then
  HOST="${LAN_IP}"
  CADDY=(sudo caddy run --config Caddyfile)
else
  HOST="${LAN_IP}:8443"
  CADDY=(caddy run --config Caddyfile)
fi
export PIXELOFFICE_HOST="${HOST}"

echo "==> Building client..."
npm run build

echo "==> Starting Node server (SERVE_CLIENT) on :2567 ..."
SERVE_CLIENT=true npm run -w server start &
SERVER_PID=$!
trap 'kill "${SERVER_PID}" 2>/dev/null || true' EXIT INT TERM

# Give the server a moment to bind before Caddy starts proxying.
sleep 2

echo ""
echo "============================================================"
echo "  PixelOffice is live over HTTPS:"
echo "    https://${HOST}"
echo ""
echo "  (first visit shows a one-time cert warning — click Proceed)"
echo "============================================================"
echo ""

"${CADDY[@]}"
