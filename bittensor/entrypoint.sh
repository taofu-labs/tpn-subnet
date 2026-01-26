#!/bin/bash
set -e

# 1. Source the .env file if it exists
if [ -f "/app/.env" ]; then
    export $(grep -v '^#' /app/.env | xargs)
fi

# 2. Logic-Aware Defaults (Aligned with ecosystem.config.js)
MODE=${RUN_MODE:-miner}
NETWORK=$(echo ${TPN_NETWORK:-finney} | tr '[:upper:]' '[:lower:]')

# Resolve NETUID and Subtensor network
if [ "$NETWORK" = "test" ]; then
    NETUID=${TPN_NETUID:-279}
    SUBTENSOR=${TPN_SUBTENSOR_NETWORK:-test}
else
    NETUID=${TPN_NETUID:-65}
    SUBTENSOR=${TPN_SUBTENSOR_NETWORK:-finney}
fi

WALLET=${TPN_WALLET_NAME:-tpn_coldkey}
HOTKEY=${TPN_HOTKEY_NAME:-tpn_hotkey}

# 3. Resolve Axon Port, Federation API URL, and Privacy
FEDERATION_URL=${TPN_FEDERATION_URL:-"http://127.0.0.1:57287"}

if [ "$MODE" = "miner" ]; then
    PORT=${TPN_AXON_PORT:-8091}
    SCRIPT="neurons/miner.py"
    EXTRA_ARGS="--blacklist.force_validator_permit --miner.server $FEDERATION_URL"
else
    PORT=${TPN_AXON_PORT:-9000}
    SCRIPT="neurons/validator.py"
    EXTRA_ARGS="--neuron.vpermit 10000 --force_validator_permit --validator_server_url $FEDERATION_URL"
fi

# Privacy flag for local testing (prevents advertising personal IP to the chain)
if [ "$TPN_AXON_OFF" = "true" ]; then
    EXTRA_ARGS="$EXTRA_ARGS --neuron.axon_off"
    echo "🛡️ Privacy Mode: Axon serving is DISABLED (IP will not be broadcast to chain)."
fi

echo "🚀 Starting TPN Neuron in $MODE mode on $NETWORK ($SUBTENSOR/UID:$NETUID)..."
echo "🌐 Federation API at: $FEDERATION_URL"

# 4. Start the Python Neuron
exec python3 $SCRIPT \
    --netuid $NETUID \
    --subtensor.network $SUBTENSOR \
    --wallet.name $WALLET \
    --wallet.hotkey $HOTKEY \
    --logging.info \
    --axon.port $PORT \
    $EXTRA_ARGS
