#!/bin/bash

# Set default values
DANTE_SERVICE_NAME=${DANTE_SERVICE_NAME:-dante}
DANTE_CONFIG_FILE="/etc/$DANTE_SERVICE_NAME.conf"
DANTE_TEMPLATE_FILE="/etc/danted.conf.template"
USER_LENGTH=${USER_LENGTH:-8}
USER_COUNT=${USER_COUNT:-1024}
PASSWORD_DIR=${PASSWORD_DIR:-/passwords}
PASSWORD_LENGTH=${PASSWORD_LENGTH:-32}

# Echo out the configuration
echo "Starting user generation and Dante server..."
echo "Password dir: ${PASSWORD_DIR}"
echo "Password length: ${PASSWORD_LENGTH}"
echo "Username length: ${USER_LENGTH}"
echo "User count: ${USER_COUNT}"

# Exit and trap on errors
set -e
trap 'echo "Error occurred at line $LINENO. Exiting."; exit 1;' ERR

# Start the Dante server
function start_dante() {

    # Create danted config file from template
    guestimated_default_adapter=$(ip route | awk '/default/ {print $5}' | head -n1)
    DANTE_ADAPTER=${ADAPTER:-$guestimated_default_adapter}
    DANTE_PORT=${PORT:-1080}
    export DANTE_ADAPTER
    export DANTE_PORT
    export DANTE_SERVICE_NAME
    envsubst < $DANTE_TEMPLATE_FILE > $DANTE_CONFIG_FILE
    chmod 644 $DANTE_CONFIG_FILE
    echo "Dante configuration written to $DANTE_CONFIG_FILE with adapter ${DANTE_ADAPTER} and port ${DANTE_PORT}:"
    echo "=======$DANTE_CONFIG_FILE========"
    cat $DANTE_CONFIG_FILE
    echo "==============================="

    # If unprivileged user "nobody" does not yet exist, create it
    if ! id -u nobody >/dev/null 2>&1; then
        echo "Creating unprivileged user 'nobody'..."
        useradd -r -s /usr/sbin/nologin nobody
    fi

    # Start the Dante server in foreground mode
    cpu_core_count=$(nproc --all)
    echo "Running Dante server on ${cpu_core_count} CPU cores"
    danted -f $DANTE_CONFIG_FILE -N $cpu_core_count

}

# Loop over /$PASSWORD_DIR/*.password.used files and delete users
for used_auth_file in "$PASSWORD_DIR"/*.password.used; do
    if [[ -f "$used_auth_file" ]]; then
        username=$(basename "$used_auth_file" .password.used)
        userdel "$username" || echo "No need to delete user $username, it does not exist."
        rm -f "$PASSWORD_DIR/$username.password"
        rm -f "$PASSWORD_DIR/$username.password.used"
    fi
done

# Check if there are any unused auth files based on /$PASSWORD_DIR/*.password if so, skip user generation
existing_auth_files_count=$(ls -1 $PASSWORD_DIR/*.password 2>/dev/null | wc -l)
if (( existing_auth_files_count > 0 )); then
    echo "Found ${existing_auth_files_count} unused auth files in ${PASSWORD_DIR}, skipping user generation."
    start_dante
    exit 0
fi

# Pre-generate random characters for all usernames and passwords to minimise /dev/urandom calls
RANDOM_BYTES_COUNT=$(( USER_COUNT * ( USER_LENGTH + PASSWORD_LENGTH ) ))
RANDOM_BYTES=$(LC_CTYPE=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c ${RANDOM_BYTES_COUNT})
if (( ${#RANDOM_BYTES} < RANDOM_BYTES_COUNT )); then
    echo "Error: Unable to generate sufficient random data" >&2
    exit 1
fi

random_slice() {
    local start=$1
    local length=$2
    printf '%s' "${RANDOM_BYTES:start:length}"
}

generate_password() {
    local slice=$(random_slice "$1" ${PASSWORD_LENGTH})
    echo "p_${slice}"
}

generate_username() {
    local slice=$(random_slice "$1" ${USER_LENGTH})
    echo "u_${slice}"
}

# Create or clear the password directory
mkdir -p "$PASSWORD_DIR"

# Generate users and passwords
PROGRESS_PCT_INTERVAL=10
PROGRESS_STEP_SIZE=$(( (USER_COUNT * PROGRESS_PCT_INTERVAL + 100 - 1) / 100 ))
if (( PROGRESS_STEP_SIZE == 0 )); then
    PROGRESS_STEP_SIZE=1
fi

# Before anything else, delete all users except the current and root
current_user=$(whoami)
allowed_users=("root" "$current_user" "ubuntu" "nobody" "bin" "list" "man" "daemon" "sys" "sync" "games" "lp" "mail" "news" "uucp" "proxy" "www-data" "backup" "list" "irc" "gnats" "nobody" "systemd-network" "systemd-resolve" "syslog" "_apt" "tss" "messagebus" "uuidd" "dnsmasq" "sshd" "landscape" "pollinate" )
echo "Cleaning up existing users except special users..."
for user in $(cut -f1 -d: /etc/passwd); do

    if [[ ! " ${allowed_users[@]} " =~ " ${user} " ]]; then
        echo "Deleting existing user: $user"
        userdel "$user" 2>/dev/null || true
    fi
    rm -f "$PASSWORD_DIR/$user.password"
    rm -f "$PASSWORD_DIR/$user.password.used"

done

echo "Generated 0/${USER_COUNT} users (0%)..."
offset=0
start_time=$(date +%s)
for i in $(seq 1 ${USER_COUNT}); do

    # Generate username and password
    USERNAME=$(generate_username ${offset})
    offset=$(( offset + USER_LENGTH ))
    PASSWORD=$(generate_password ${offset})
    offset=$(( offset + PASSWORD_LENGTH ))

    # Append to password file
    echo "${PASSWORD}" >> "$PASSWORD_DIR/$USERNAME.password"

    # Create user in system, no home directory, no shell access
    useradd -M -s /usr/sbin/nologin "${USERNAME}"
    echo "${USERNAME}:${PASSWORD}" | chpasswd

    # Update progress
    if (( i == USER_COUNT || i % PROGRESS_STEP_SIZE == 0 )); then
        PROGRESS_PERCENT=$(( i * 100 / USER_COUNT ))
        echo "Generated ${i}/${USER_COUNT} users (${PROGRESS_PERCENT}%)..."
    fi

done
end_time=$(date +%s)
elapsed=$(( end_time - start_time ))
echo "User generation completed in ${elapsed} seconds."

# Echo the password file line count
echo "Generated $(ls -1 $PASSWORD_DIR/*.password | wc -l) users."

# Set up PAM service for Dante
PAM_FILE="/etc/pam.d/${DANTE_SERVICE_NAME}"
echo "Setting up PAM service for Dante at ${PAM_FILE}..."
mkdir -p /etc/pam.d
echo "auth   required    pam_unix.so" > "${PAM_FILE}"
echo "account required    pam_unix.so" >> "${PAM_FILE}"
chmod 644 "${PAM_FILE}"
echo "PAM service ${DANTE_SERVICE_NAME} configured."
echo "=======${PAM_FILE}========"
cat "${PAM_FILE}"
echo "==============================="

start_dante