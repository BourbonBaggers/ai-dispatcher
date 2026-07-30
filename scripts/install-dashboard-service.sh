#!/usr/bin/env bash
# install-dashboard-service.sh — install the read-only dispatcher dashboard as a user service.
set -euo pipefail

HOST="${DASHBOARD_HOST:-0.0.0.0}"
PORT="${DASHBOARD_PORT:-8787}"
UNIT="${DASHBOARD_UNIT:-ai-dispatcher-dashboard.service}"
CHECKOUT="${DASHBOARD_CHECKOUT:-$HOME/ai-dispatcher}"
NODE_BIN="${DASHBOARD_NODE_BIN:-$HOME/.nvm/versions/node/v24.18.0/bin/node}"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_PATH="$UNIT_DIR/$UNIT"

mkdir -p "$UNIT_DIR"

cat >"$UNIT_PATH" <<EOF
[Unit]
Description=AI Dispatcher status dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$CHECKOUT
Environment=PATH=$HOME/bin:$HOME/.nvm/versions/node/v24.18.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=$NODE_BIN bin/ai-dispatcher.mjs dashboard --host $HOST --port $PORT
Restart=on-failure
RestartSec=10
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now "$UNIT"
systemctl --user --no-pager --full status "$UNIT"
