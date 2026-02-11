#!/usr/bin/with-contenv bash
# shellcheck shell=bash
# shellcheck disable=SC2016,SC1091,SC2183

# ============================================
# Traffic obfuscation rules
# Reduces fingerprinting vectors used to detect VPN traffic
# ============================================

echo "**** Applying traffic obfuscation rules ****"

# MSS clamping: defeats MTU fingerprinting
# WireGuard adds 60-byte overhead creating ~1420 MTU vs residential 1500
iptables -t mangle -A POSTROUTING -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu 2>/dev/null || true
iptables -t mangle -A FORWARD -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu 2>/dev/null || true

# TTL normalization: defeats hop count analysis
# VPN reprocessing creates inconsistent TTL values revealing intermediate hops
iptables -t mangle -A POSTROUTING -j TTL --ttl-set 64 2>/dev/null || true
iptables -t mangle -A FORWARD -j TTL --ttl-set 64 2>/dev/null || true

echo "**** Traffic obfuscation rules applied ****"

# ============================================

mkdir -p /config/wg_confs

# Remove ready marker - generation is starting
rm -f /config/.wg_ready

# migration to subfolder for wg confs
if [[ -z "$(ls -A /config/wg_confs)" ]] && [[ -f /config/wg0.conf ]]; then
    echo "**** Performing migration to new folder structure for confs. Please see the image changelog 2023-10-03 entry for more details. ****"
    cp /config/wg0.conf /config/wg_confs/wg0.conf
    rm -rf /config/wg0.conf || :
fi

# prepare templates
if [[ ! -f /config/templates/server.conf ]]; then
    cp /defaults/server.conf /config/templates/server.conf
fi
if [[ ! -f /config/templates/peer.conf ]]; then
    cp /defaults/peer.conf /config/templates/peer.conf
fi
# add preshared key to user templates (backwards compatibility)
if ! grep -q 'PresharedKey' /config/templates/peer.conf; then
    sed -i 's|^Endpoint|PresharedKey = \$\(cat /config/\${PEER_ID}/presharedkey-\${PEER_ID}\)\nEndpoint|' /config/templates/peer.conf
fi

generate_confs () {

    # Create server keys if not present or corrupted
    # WireGuard keys are base64: exactly 44 chars (43 + '=')
    mkdir -p /config/server
    SERVER_PRIVKEY=$(cat /config/server/privatekey-server 2>/dev/null)
    SERVER_PUBKEY=$(cat /config/server/publickey-server 2>/dev/null)
    if [[ ! "${SERVER_PRIVKEY}" =~ ^[A-Za-z0-9+/]{43}=$ ]] || [[ ! "${SERVER_PUBKEY}" =~ ^[A-Za-z0-9+/]{43}=$ ]]; then
        if [[ -f /config/server/privatekey-server ]] || [[ -f /config/server/publickey-server ]]; then
            echo "**** WARNING: Corrupted or invalid server keys. Regenerating. ****"
        fi
        umask 077
        wg genkey | tee /config/server/privatekey-server | wg pubkey > /config/server/publickey-server
    fi
    # Build into a prefile and atomically replace final config at the end
    local WG_DIR="/config/wg_confs"
    local PREFILE="${WG_DIR}/wg0.conf.pre"
    local FINALFILE="${WG_DIR}/wg0.conf"
    mkdir -p "${WG_DIR}"

    eval "$(printf %s)
    cat <<DUDE > ${PREFILE}
$(cat /config/templates/server.conf)

DUDE"

    # For each peer, create keys and conf if not present
    for i in "${PEERS_ARRAY[@]}"; do
        if [[ ! "${i}" =~ ^[[:alnum:]]+$ ]]; then
            echo "**** Peer ${i} contains non-alphanumeric characters and thus will be skipped. No config for peer ${i} will be generated. ****"
        else
            if [[ "${i}" =~ ^[0-9]+$ ]]; then
                PEER_ID="peer${i}"
            else
                PEER_ID="peer_${i}"
            fi

            # Create peer folder
            mkdir -p "/config/${PEER_ID}"

            # Reset CLIENT_IP for each peer to prevent stale values from previous iteration
            CLIENT_IP=""

            # Create peer keys if they do not exist or are corrupted
            # WireGuard keys are base64: exactly 44 chars (43 + '=')
            PRIVKEY=$(cat "/config/${PEER_ID}/privatekey-${PEER_ID}" 2>/dev/null)
            PUBKEY=$(cat "/config/${PEER_ID}/publickey-${PEER_ID}" 2>/dev/null)
            if [[ ! "${PRIVKEY}" =~ ^[A-Za-z0-9+/]{43}=$ ]] || [[ ! "${PUBKEY}" =~ ^[A-Za-z0-9+/]{43}=$ ]]; then
                if [[ -f "/config/${PEER_ID}/privatekey-${PEER_ID}" ]] || [[ -f "/config/${PEER_ID}/publickey-${PEER_ID}" ]]; then
                    echo "**** WARNING: Corrupted or invalid keys for ${PEER_ID}. Regenerating. ****"
                fi
                umask 077
                wg genkey | tee "/config/${PEER_ID}/privatekey-${PEER_ID}" | wg pubkey > "/config/${PEER_ID}/publickey-${PEER_ID}"
                wg genpsk > "/config/${PEER_ID}/presharedkey-${PEER_ID}"
            fi

            # If conf already exists, extract the IP from it
            if [[ -f "/config/${PEER_ID}/${PEER_ID}.conf" ]]; then
                CLIENT_IP=$(grep "Address" "/config/${PEER_ID}/${PEER_ID}.conf" | awk '{print $NF}')
                if [[ -n "${ORIG_INTERFACE}" ]] && [[ "${INTERFACE}" != "${ORIG_INTERFACE}" ]]; then
                    CLIENT_IP="${CLIENT_IP//${ORIG_INTERFACE}/${INTERFACE}}"
                fi

                # Validate extracted IP - if broken, treat as if no config exists
                if [[ ! "${CLIENT_IP}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+(/[0-9]+)?$ ]]; then
                    echo "**** WARNING: Broken Address in ${PEER_ID} config (got: '${CLIENT_IP}'). Repairing with new IP. ****"
                    CLIENT_IP=""
                fi
            fi

            # If CLIENT_IP is still empty (no config OR broken config), find a new IP
            if [[ -z "${CLIENT_IP}" ]]; then
                for idx in {2..254}; do
                    PROPOSED_IP="${INTERFACE}.${idx}"
                    if ! grep -q -R "${PROPOSED_IP}" /config/peer*/*.conf 2>/dev/null && \
                        ([[ -z "${ORIG_INTERFACE}" ]] || ! grep -q -R "${ORIG_INTERFACE}.${idx}" /config/peer*/*.conf 2>/dev/null); then
                        CLIENT_IP="${PROPOSED_IP}"
                        break
                    fi
                done
            fi

            # Final validation - skip peer if we still couldn't assign an IP
            if [[ -z "${CLIENT_IP}" ]]; then
                echo "**** ERROR: Could not assign IP for peer ${i} (all IPs exhausted?). Skipping. ****"
                continue
            fi

            # Validate preshared key if it exists, regenerate if corrupted
            PSKFILE="/config/${PEER_ID}/presharedkey-${PEER_ID}"
            if [[ -f "${PSKFILE}" ]]; then
                PSK=$(cat "${PSKFILE}" 2>/dev/null)
                if [[ ! "${PSK}" =~ ^[A-Za-z0-9+/]{43}=$ ]]; then
                    echo "**** WARNING: Corrupted preshared key for ${PEER_ID}. Regenerating. ****"
                    wg genpsk > "${PSKFILE}"
                fi
            fi

            # Create peer conf file and add peer to server conf
            if [[ -f "${PSKFILE}" ]]; then
                # create peer conf with presharedkey
                eval "$(printf %s)
                cat <<DUDE > /config/${PEER_ID}/${PEER_ID}.conf
$(cat /config/templates/peer.conf)
DUDE"
                # add peer info to pre server conf with presharedkey
                cat <<DUDE >> ${PREFILE}
[Peer]
# ${PEER_ID}
PublicKey = $(cat "/config/${PEER_ID}/publickey-${PEER_ID}")
PresharedKey = $(cat "${PSKFILE}")
DUDE
            else
                echo "**** Existing keys with no preshared key found for ${PEER_ID}, creating confs without preshared key for backwards compatibility ****"
                # create peer conf without presharedkey
                eval "$(printf %s)
                cat <<DUDE > /config/${PEER_ID}/${PEER_ID}.conf
$(sed '/PresharedKey/d' "/config/templates/peer.conf")
DUDE"
                # add peer info to pre server conf without presharedkey
                cat <<DUDE >> ${PREFILE}
[Peer]
# ${PEER_ID}
PublicKey = $(cat "/config/${PEER_ID}/publickey-${PEER_ID}")
DUDE
            fi
            SERVER_ALLOWEDIPS=SERVER_ALLOWEDIPS_PEER_${i}
            # add peer's allowedips to pre server conf
            if [[ -n "${!SERVER_ALLOWEDIPS}" ]]; then
                echo "Adding ${!SERVER_ALLOWEDIPS} to wg0.conf's AllowedIPs for peer ${i}"
                cat <<DUDE >> ${PREFILE}
AllowedIPs = ${CLIENT_IP}/32,${!SERVER_ALLOWEDIPS}
DUDE
            else
                cat <<DUDE >> ${PREFILE}
AllowedIPs = ${CLIENT_IP}/32
DUDE
            fi
            # add PersistentKeepalive if the peer is specified
            if [[ -n "${PERSISTENTKEEPALIVE_PEERS_ARRAY}" ]] && ([[ "${PERSISTENTKEEPALIVE_PEERS_ARRAY[0]}" = "all" ]] || printf '%s\0' "${PERSISTENTKEEPALIVE_PEERS_ARRAY[@]}" | grep -Fxqz -- "${i}"); then
                cat <<DUDE >> ${PREFILE}
PersistentKeepalive = 25

DUDE
            else
                cat <<DUDE >> ${PREFILE}

DUDE
            fi

            # Log the conf file and QR code
            if [[ -z "${LOG_CONFS}" ]] || [[ "${LOG_CONFS}" = "true" ]]; then
                echo "PEER ${i} QR code (conf file is saved under /config/${PEER_ID}):"
                # qrencode -t ansiutf8 < "/config/${PEER_ID}/${PEER_ID}.conf"
            else
                echo "PEER ${i} conf and QR code png saved in /config/${PEER_ID}"
            fi
            # qrencode -o "/config/${PEER_ID}/${PEER_ID}.png" < "/config/${PEER_ID}/${PEER_ID}.conf"
        fi
    done

    # Atomically move the prefile into place
    mv -f "${PREFILE}" "${FINALFILE}"

    # Signal that generation is complete
    touch /config/.wg_ready
}

save_vars () {
    cat <<DUDE > /config/.donoteditthisfile
ORIG_SERVERURL="$SERVERURL"
ORIG_SERVERPORT="$SERVERPORT"
ORIG_PEERDNS="$PEERDNS"
ORIG_PEERS="$PEERS"
ORIG_INTERFACE="$INTERFACE"
ORIG_ALLOWEDIPS="$ALLOWEDIPS"
ORIG_PERSISTENTKEEPALIVE_PEERS="$PERSISTENTKEEPALIVE_PEERS"
DUDE
}

if [[ -n "$PEERS" ]]; then
    echo "**** Server mode is selected ****"
    if [[ "$PEERS" =~ ^[0-9]+$ ]] && ! [[ "$PEERS" = *,* ]]; then
        mapfile -t PEERS_ARRAY < <(seq 1 "${PEERS}")
    else
        mapfile -t PEERS_ARRAY < <(echo "${PEERS}" | tr ',' '\n')
    fi
    if [[ -n "${PERSISTENTKEEPALIVE_PEERS}" ]]; then
        echo "**** PersistentKeepalive will be set for: ${PERSISTENTKEEPALIVE_PEERS/,/ } ****"
        mapfile -t PERSISTENTKEEPALIVE_PEERS_ARRAY < <(echo "${PERSISTENTKEEPALIVE_PEERS}" | tr ',' '\n')
    fi
    if [[ -z "$SERVERURL" ]] || [[ "$SERVERURL" = "auto" ]]; then
        # Try multiple IPv4 detection services with failover
        for ip_service in "https://ipv4.icanhazip.com" "https://api.ipify.org" "https://ifconfig.me" "https://ipecho.net/plain"; do
            SERVERURL=$(curl -sf --connect-timeout 5 "$ip_service" 2>/dev/null | tr -d '[:space:]')
            # Validate we got a valid IPv4 address
            if [[ "${SERVERURL}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
                echo "**** Auto-detected external IP: $SERVERURL (via $ip_service) ****"
                break
            fi
            SERVERURL=""
        done
        # Final check - fail loudly if no IP could be detected
        if [[ -z "$SERVERURL" ]]; then
            echo "**** ERROR: Could not auto-detect external IP. Set SERVERURL manually. ****"
            exit 1
        fi
    else
        echo "**** External server address is set to $SERVERURL ****"
    fi
    SERVERPORT=${SERVERPORT:-51820}
    echo "**** External server port is set to ${SERVERPORT}. Make sure that port is properly forwarded to port 51820 inside this container ****"
    INTERNAL_SUBNET=${INTERNAL_SUBNET:-10.13.13.0}
    echo "**** Internal subnet is set to $INTERNAL_SUBNET ****"
    INTERFACE=$(echo "$INTERNAL_SUBNET" | awk 'BEGIN{FS=OFS="."} NF--')
    ALLOWEDIPS=${ALLOWEDIPS:-0.0.0.0/0, ::/0}
    echo "**** AllowedIPs for peers $ALLOWEDIPS ****"
    if [[ -z "$PEERDNS" ]] || [[ "$PEERDNS" = "auto" ]]; then
        PEERDNS="${INTERFACE}.1"
        echo "**** PEERDNS var is either not set or is set to \"auto\", setting peer DNS to ${INTERFACE}.1 to use wireguard docker host's DNS. ****"
    else
        echo "**** Peer DNS servers will be set to $PEERDNS ****"
    fi
    if [[ ! -f /config/wg_confs/wg0.conf ]]; then
        echo "**** No wg0.conf found (maybe an initial install), generating 1 server and ${PEERS} peer/client confs ****"
        # Commented out in lieu of force regen below
        # generate_confs
        save_vars
    else
        echo "**** Server mode is selected ****"
        if [[ -f /config/.donoteditthisfile ]]; then
            . /config/.donoteditthisfile
        fi
        if [[ "$SERVERURL" != "$ORIG_SERVERURL" ]] || [[ "$SERVERPORT" != "$ORIG_SERVERPORT" ]] || [[ "$PEERDNS" != "$ORIG_PEERDNS" ]] || [[ "$PEERS" != "$ORIG_PEERS" ]] || [[ "$INTERFACE" != "$ORIG_INTERFACE" ]] || [[ "$ALLOWEDIPS" != "$ORIG_ALLOWEDIPS" ]] || [[ "$PERSISTENTKEEPALIVE_PEERS" != "$ORIG_PERSISTENTKEEPALIVE_PEERS" ]]; then
            echo "**** Server related environment variables changed, regenerating 1 server and ${PEERS} peer/client confs ****"
            # Commented out in lieu of force regen below
            # generate_confs
            save_vars
        else
            echo "**** No changes to parameters.****"
        fi
    fi
else
    echo "**** Client mode selected. ****"
    USE_COREDNS="${USE_COREDNS,,}"
    printf %s "${USE_COREDNS:-false}" > /run/s6/container_environment/USE_COREDNS
fi

# set up CoreDNS
if [[ ! -f /config/coredns/Corefile ]]; then
    cp /defaults/Corefile /config/coredns/Corefile
fi

# permissions
lsiown -R abc:abc \
    /config

# Force regen on boot
generate_confs 
