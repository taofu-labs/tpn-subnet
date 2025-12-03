#!/bin/bash

set -euo pipefail

cleanup() {
    if [ "${stash_created:-false}" = true ] && [ "${stash_popped:-false}" != true ]; then
        echo "Cleanup: attempting to pop temporary stash."
        git -C "${TPN_DIR:-.}" stash pop >/dev/null 2>&1 || echo "Cleanup: no stash to pop or pop failed."
    fi
}

trap cleanup EXIT

# Default values for flags
TPN_DIR=~/tpn-subnet
ENABLE_AUTOUPDATE=true
FORCE_RESTART=true
stash_created=false
stash_popped=false

# RAM settings
QUARTER_OF_FREE_RAM=$(($(free -m | awk 'NR==2{print $2}') * 3 / 4))
export CONTAINER_MAX_PROCESS_RAM_MB=${CONTAINER_MAX_PROCESS_RAM_MB:-$QUARTER_OF_FREE_RAM}

# Help message
print_help() {
  echo "Usage: $0 [OPTIONS]"
  echo ""
  echo "Options:"
  echo "  --tpn_dir=PATH               Path to the TPN repository (default: ~/tpn-subnet)"
  echo "  --enable_autoupdate=true|false  Enable or disable crontab auto-update (default: true)"
  echo "  --force_restart=true|false     Force restart regardless of repository update (default: true)"
  echo "  --pm2_process_name=NAME        Name of the pm2 process to restart"
  echo "  --help                         Show this help message and exit"
  exit 0
}

# --------------------
# Helpers
# --------------------

green() {
  if [ $# -gt 0 ]; then
    printf '\033[0;32m%s\033[0m\n' "$*"
  else
    while IFS= read -r line; do
      printf '\033[0;32m%s\033[0m\n' "$line"
    done
  fi
}

red() {
  if [ $# -gt 0 ]; then
    printf '\033[0;31m%s\033[0m\n' "$*"
  else
    while IFS= read -r line; do
      printf '\033[0;31m%s\033[0m\n' "$line"
    done
  fi
}

grey() {
  if [ $# -gt 0 ]; then
    printf '\033[0;90m%s\033[0m\n' "$*"
  else
    while IFS= read -r line; do
      printf '\033[0;90m%s\033[0m\n' "$line"
    done
  fi
}


# Parse command-line arguments
for arg in "$@"; do
  case $arg in
    --tpn_dir=*)
      TPN_DIR="${arg#*=}"
      shift
      ;;
    --enable_autoupdate=*)
      ENABLE_AUTOUPDATE="${arg#*=}"
      shift
      ;;
    --force_restart=*)
      FORCE_RESTART="${arg#*=}"
      shift
      ;;
    --pm2_process_name=*)
      PM2_PROCESS_NAME="${arg#*=}"
      shift
      ;;
    --help|-h)
      print_help
      ;;
    *)
      echo "Unknown argument: $arg"
      echo "Use --help to see available options."
      exit 1
      ;;
  esac
done

# Check for TPN repository
if [ ! -d "$TPN_DIR" ]; then
    red "TPN repository not found at $TPN_DIR. Please clone it first."
    exit 1
fi

# First, load the environment variables in federated-container/.env
if [ -f "$TPN_DIR/federated-container/.env" ]; then
    set -a
    . "$TPN_DIR/federated-container/.env"
    set +a
else
    red "Warning: .env file not found in $TPN_DIR/federated-container. Exiting."
    exit 1
fi

# Run mode settings
RUN_MODE="${RUN_MODE:-}"
if [ "$RUN_MODE" != "worker" ] && [ "$RUN_MODE" != "miner" ] && [ "$RUN_MODE" != "validator" ]; then
    red "RUN_MODE must be one of worker, miner, or validator. Current value: '$RUN_MODE'." >&2
    exit 1
fi

# Set default pm2 process name if not provided
PM2_PROCESS_NAME=${PM2_PROCESS_NAME:-tpn_$RUN_MODE}

# Get pm2 binary, default to $HOME/.npm-global/bin/pm2
PM2_BIN_PATH=$(command -v pm2 || echo "$HOME/.npm-global/bin/pm2")

CURRENT_BRANCH=$(git -C "$TPN_DIR" rev-parse --abbrev-ref HEAD)
# Set the image tag based on the branch
if [ "$CURRENT_BRANCH" = "development" ]; then
    export TPN_IMAGE_TAG='latest-dev'
else
    export TPN_IMAGE_TAG='latest'
fi

# Generate docker command base
DOCKER_CMD=(docker compose -f "$TPN_DIR/federated-container/docker-compose.yml")

# If swag-related environment variables are set, set profile to proxy. SWAG_DOMAIN_NAME must be set and SWAG_DISABLE_SSL must not be true, SWAG_DOMAIN_NAME must not be the default value of your.domain.com
if [ -n "${SWAG_DOMAIN_NAME:-}" ] && [ "${SWAG_DISABLE_SSL:-false}" != "true" ] && [ "${SWAG_DOMAIN_NAME:-}" != "your.domain.com" ]; then
    echo "Enabling proxy profile for SWAG configuration."
    DOCKER_CMD+=(--profile proxy)
fi

# If run mode is worker, add --profile worker
if [ "$RUN_MODE" = "worker" ]; then
    DOCKER_CMD+=(--profile worker)
fi

# Log out run details
SERVER_PUBLIC_HOST_VALUE="${SERVER_PUBLIC_HOST:-unknown}"
SERVER_PUBLIC_PORT_VALUE="${SERVER_PUBLIC_PORT:-unknown}"
echo "Updating $RUN_MODE node on branch $CURRENT_BRANCH, configured to run at $SERVER_PUBLIC_HOST_VALUE:$SERVER_PUBLIC_PORT_VALUE"
echo -n "Command base:"
printf ' %q' "${DOCKER_CMD[@]}"
printf '\n'

# Define the command to ensure in crontab
restart_command="0 * * * * bash $TPN_DIR/scripts/update_node.sh --force_restart=false"

if [ "$ENABLE_AUTOUPDATE" = "true" ]; then

    # Dump crontab, fallback to empty if none exists
    existing_cron=$(crontab -l 2>/dev/null || true)
    
    # Check if restart_command already exists
    if ! printf '%s\n' "$existing_cron" | grep -Fxq "$restart_command"; then

        # Remove any old node update entries
        new_cron=$(printf "%s" "$existing_cron" | grep -v "scripts/update_node.sh" || true)

        # Append the new cron job
        new_cron=$(printf "%s\n%s" "$new_cron" "$restart_command")

        # Add the correct restart_command
        printf "%s\n" "$new_cron" | crontab -
        grey "Tab is now up to date"

    else

        grey "Tab was already up to date, no changes made."

    fi
else
    grey "Autoupdate disabled, skipping crontab check."
fi

# Stash local changes before pulling
echo "Stashing local changes before pulling on branch $CURRENT_BRANCH."
pre_stash_ref=$(git -C "$TPN_DIR" rev-parse --verify --quiet refs/stash || true)
if git -C "$TPN_DIR" stash push -m "Stash before update on $(date)" >/dev/null 2>&1; then
    post_stash_ref=$(git -C "$TPN_DIR" rev-parse --verify --quiet refs/stash || true)
    if [ "$pre_stash_ref" != "$post_stash_ref" ]; then
        stash_created=true
    else
        grey "No changes to stash."
    fi
else
    echo "Failed to stash changes, continuing anyway."
fi

# Update the TPN repository
cd "$TPN_DIR" || exit 1
pull_output=$(git pull 2>&1)
printf "%s\n" "$pull_output"
if printf "%s\n" "$pull_output" | grep -q "Already up to date."; then
    REPO_UP_TO_DATE=1
else
    REPO_UP_TO_DATE=0
fi

# Pop the stash if it was created
if [ "$stash_created" = true ]; then
    echo "Restoring stashed changes on branch $CURRENT_BRANCH."
    if git -C "$TPN_DIR" stash pop >/dev/null 2>&1; then
        stash_popped=true
    else
        echo "Failed to pop stash, continuing anyway."
    fi
fi

# If force_restart flag is true, pretend repo is not up to date
if [ "$FORCE_RESTART" = "true" ]; then
    echo "Force restart enabled, treating repository as changed."
    REPO_UP_TO_DATE=0
fi

# Pull the latest docker images
grey "Pulling latest docker images..."
"${DOCKER_CMD[@]}" pull -q
grey "Latest docker images pulled."

# Restart the node docker container if needed
if [ "$REPO_UP_TO_DATE" -eq 0 ]; then
    echo "Repository has changes, force restarting docker process..."
    "${DOCKER_CMD[@]}" down
    echo "Pruning unused images..."
    docker image prune -f || echo "Failed to prune unused images."
    echo "Pruning unused networks..."
    docker network prune -f || echo "Failed to prune unused networks."
else
    grey "No changes in the repository, no need to force restart docker."
fi

# Bring node back up
"${DOCKER_CMD[@]}" up -d

# Restart the pm2 process if needed, only for non worker nodes
if [ "$RUN_MODE" != "worker" ]; then

    # Restart neuron process if repo has changes
    if [ "$REPO_UP_TO_DATE" -eq 0 ]; then

        # Update python dependencies
        echo "Repository has changes, updating python dependencies..."
        cd ~/tpn-subnet
        python3 -m venv venv
        source venv/bin/activate
        TPN_CACHE="$HOME/.tpn_cache"
        mkdir -p $TPN_CACHE
        export TMPDIR=$TPN_CACHE
        export WANDB_CACHE_DIR=$TPN_CACHE
        pip3 install -r requirements.txt
    
        echo "Repository has changes, restarting pm2 process $PM2_PROCESS_NAME..."
        $PM2_BIN_PATH restart "$PM2_PROCESS_NAME" || red "Failed to restart pm2 process $PM2_PROCESS_NAME. Please d so manually."

    else
        grey "No changes in the repository, skipping pm2 restart."
    fi
else
    grey "pm2 not relevant in worker mode, skipping pm2 restart."
fi

# Do a sanity check on open ports
SERVER_PUBLIC_PORT="${SERVER_PUBLIC_PORT:-3000}"
DANTE_PORT="${DANTE_PORT:-1080}"
WIREGUARD_SERVERPORT="${WIREGUARD_SERVERPORT:-51820}"
NETCAT_AVAILABLE=$(command -v nc || command -v netcat || echo "")
if [ -n "$NETCAT_AVAILABLE" ]; then
    echo "Performing sanity check on open ports..."

    # For every run mode, the public port (tcp) and wireguard (udp) port are suggested to be open (but in many cases docker will bypass localised firewall rules)
    if nc -zv localhost "$SERVER_PUBLIC_PORT" >/dev/null 2>&1; then
        green "✅ Public port $SERVER_PUBLIC_PORT/tcp is open."
    else 
        echo "🚨 Warning: Public port $SERVER_PUBLIC_PORT/tcp is not open. It is recommended to open it in your firewall for proper node functionality."
    fi
    if nc -zvu localhost "$WIREGUARD_SERVERPORT" >/dev/null 2>&1; then
        green "✅ Wireguard port $WIREGUARD_SERVERPORT/udp is open."
    else 
        echo "🚨 Warning: Wireguard port $WIREGUARD_SERVERPORT/udp is not open. It is recommended to open it in your firewall for proper node functionality."
    fi

    # For worker mode, dante port MUST be open because the container does not bypass local firewall rules
    if [ "$RUN_MODE" = "worker" ]; then
        if nc -zv localhost "$DANTE_PORT" >/dev/null 2>&1; then
            green "✅ Dante port $DANTE_PORT/tcp is open."
        else 
            red "🚨 Error: Dante port $DANTE_PORT/tcp is not open. Please open it in your firewall for proper worker functionality."
        fi
    fi


else
    echo "⚠️ Netcat not available, skipping port sanity checks. Please install netcat-openbsd package to enable this feature."
fi



green "\n✅ Update completed successfully"
