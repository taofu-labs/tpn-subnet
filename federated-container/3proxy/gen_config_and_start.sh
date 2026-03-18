#!/bin/bash

# 3proxy HTTP-to-SOCKS5 bridge entrypoint
# Generates 3proxy config from Dante's password files and keeps it in sync via inotify

set -e
trap 'echo "Error occurred at line $LINENO. Exiting."; exit 1;' ERR

# Graceful shutdown — forward SIGTERM/SIGINT to the 3proxy child process
shutdown() {
    echo "Received shutdown signal, stopping 3proxy..."
    local pid
    pid=$(cat "$PIDFILE" 2>/dev/null || true)
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
    fi
    exit 0
}
trap shutdown SIGTERM SIGINT

CONFIG="/etc/3proxy/3proxy.cfg"
PIDFILE="/var/run/3proxy.pid"
PROXY_PORT=${PROXY_PORT:-3128}
DANTE_HOST=${DANTE_HOST:-dante}
DANTE_PORT=${DANTE_PORT:-1080}
PASSWORD_DIR=${PASSWORD_DIR:-/passwords}

echo -e "\n======================================"
echo "3proxy HTTP Proxy Initialization"
echo -e "======================================\n"
echo "Proxy port:  ${PROXY_PORT}"
echo "Dante host:  ${DANTE_HOST}:${DANTE_PORT}"
echo "Password dir: ${PASSWORD_DIR}"

# ---------------------------------------------------------------------------
# Config generation — reads /passwords/*.password and builds 3proxy.cfg
# ---------------------------------------------------------------------------

generate_config() {

    local tmpfile
    mkdir -p "$(dirname "$CONFIG")"
    tmpfile=$(mktemp "${CONFIG}.XXXXXX")

    # Header: DNS, timeouts, logging, connection limits
    cat > "$tmpfile" <<EOF
nscache 65536
nserver 8.8.8.8
nserver 8.8.4.4
timeouts 1 5 30 60 180 1800 15 60
log /dev/stdout
maxconn 512
auth strong
EOF

    # Collect users first — 3proxy wants all `users` lines before ACL/parent rules
    for f in "$PASSWORD_DIR"/*.password; do
        [ -f "$f" ] || continue
        user=$(basename "$f" .password)
        pass=$(cat "$f")
        echo "users ${user}:CL:${pass}" >> "$tmpfile"
    done

    # Per-user ACL + SOCKS5 parent chain
    # Each user gets their own `allow` + `parent` pair so 3proxy authenticates
    # to Dante with the matching credentials
    for f in "$PASSWORD_DIR"/*.password; do
        [ -f "$f" ] || continue
        user=$(basename "$f" .password)
        pass=$(cat "$f")
        echo "allow ${user}" >> "$tmpfile"
        echo "parent 1000 socks5+ ${DANTE_HOST} ${DANTE_PORT} ${user} ${pass}" >> "$tmpfile"
    done

    # Start the HTTP CONNECT listener
    echo "proxy -p${PROXY_PORT}" >> "$tmpfile"

    # Atomic swap — prevents 3proxy from reading a half-written config
    chmod 600 "$tmpfile"
    mv "$tmpfile" "$CONFIG"

    user_count=$(grep -c '^users ' "$CONFIG" 2>/dev/null || echo 0)
    echo "Generated 3proxy config with ${user_count} users"

}

# ---------------------------------------------------------------------------
# inotify watcher — regenerates config when password files change
# ---------------------------------------------------------------------------

config_watcher() {

    # Non-fatal — if the watcher dies we still serve with the last-known config
    set +e

    if ! command -v inotifywait &>/dev/null; then
        echo "Config watcher: inotifywait not found, live reload disabled"
        return 1
    fi

    if [[ ! -d "$PASSWORD_DIR" ]]; then
        echo "Config watcher: ${PASSWORD_DIR} does not exist, live reload disabled"
        return 1
    fi

    echo "Config watcher: watching ${PASSWORD_DIR} for credential changes..."

    inotifywait -m -e create -e modify -e delete "$PASSWORD_DIR" |
    while read -r dir event filename; do

        # Only react to .password files
        [[ "$filename" != *.password ]] && continue

        echo "Config watcher: detected ${event} on ${filename}, debouncing..."

        # Debounce — multiple files may change in quick succession
        sleep 2

        echo "Config watcher: regenerating config..."
        generate_config

        # Gracefully restart 3proxy by killing the current process
        # PID is read from file since the watcher runs in a separate subprocess
        local pid
        pid=$(cat "$PIDFILE" 2>/dev/null || true)
        if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
            echo "Config watcher: restarting 3proxy (pid ${pid})..."
            kill "$pid" 2>/dev/null || true
        fi

    done

}

# ---------------------------------------------------------------------------
# Start 3proxy in a restart loop (so config_watcher can trigger reloads)
# ---------------------------------------------------------------------------

start_proxy() {

    # Launch the config watcher in the background
    config_watcher &

    while true; do
        echo "Starting 3proxy with config ${CONFIG}..."
        3proxy "$CONFIG" &
        local pid=$!
        echo "$pid" > "$PIDFILE"

        # Wait for 3proxy to exit (either crash or watcher-triggered kill)
        # wait returns 143 (128+15) on SIGTERM — the shutdown trap handles cleanup
        wait "$pid" || true
        echo "3proxy exited, restarting in 1s..."
        sleep 1
    done

}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

generate_config
start_proxy
