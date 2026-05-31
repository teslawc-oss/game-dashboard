#!/bin/zsh
set -euo pipefail
exec /opt/homebrew/bin/caddy run --config /Users/bert/game-dashboard/config/caddy/Caddyfile --adapter caddyfile
