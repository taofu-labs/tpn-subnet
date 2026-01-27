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

# Watch for user regeneration trigger files in /dante_regen_requests/
# External processes can touch a file named after a user (e.g. u_iCvUawJU) to regenerate that user's credentials
REGEN_DIR="/dante_regen_requests"

regen_watcher() {

    # Disable set -e so a single failed regen doesn't kill the watcher
    set +e

    echo "Regen watcher: listening for trigger files in ${REGEN_DIR}..."

    # Verify inotifywait is available before starting the watch loop
    if ! command -v inotifywait &>/dev/null; then
        echo "Regen watcher: ERROR - inotifywait not found, regen watcher disabled"
        return 1
    fi

    # Verify the regen directory exists and is watchable
    if [[ ! -d "${REGEN_DIR}" ]]; then
        echo "Regen watcher: ERROR - ${REGEN_DIR} does not exist, regen watcher disabled"
        return 1
    fi

    inotifywait -m -e create "${REGEN_DIR}" |
    while read -r dir event filename; do

        # Only process user trigger files (u_ prefix)
        [[ "$filename" != u_* ]] && continue

        # Only regen existing users, skip unknown ones
        if ! id "$filename" &>/dev/null; then
            echo "Regen watcher: ignoring unknown user ${filename}"
            rm -f "${REGEN_DIR}/${filename}"
            continue
        fi

        echo "Regen watcher: regenerating credentials for ${filename}..."

        # Delete existing user entry before recreating
        if ! userdel "$filename" 2>/dev/null; then
            echo "Regen watcher: WARNING - failed to delete user ${filename}, attempting to continue anyway"
        fi

        # Generate a fresh password
        new_password="p_$(tr -dc 'A-Za-z0-9' < /dev/urandom | head -c ${PASSWORD_LENGTH})"
        if [[ -z "$new_password" || "$new_password" == "p_" ]]; then
            echo "Regen watcher: ERROR - failed to generate password for ${filename}, skipping"
            rm -f "${REGEN_DIR}/${filename}"
            continue
        fi

        # Recreate the system user
        if ! useradd -M -s /usr/sbin/nologin "$filename"; then
            echo "Regen watcher: ERROR - failed to create user ${filename}, skipping"
            rm -f "${REGEN_DIR}/${filename}"
            continue
        fi

        # Set the new password
        if ! echo "${filename}:${new_password}" | chpasswd; then
            echo "Regen watcher: ERROR - failed to set password for ${filename}, cleaning up"
            userdel "$filename" 2>/dev/null
            rm -f "${REGEN_DIR}/${filename}"
            continue
        fi

        # Write new password file and clear the used marker
        if ! echo "${new_password}" > "${PASSWORD_DIR}/${filename}.password"; then
            echo "Regen watcher: ERROR - failed to write password file for ${filename}"
            rm -f "${REGEN_DIR}/${filename}"
            continue
        fi
        rm -f "${PASSWORD_DIR}/${filename}.password.used"

        # Remove the trigger file so the caller knows it was processed
        rm -f "${REGEN_DIR}/${filename}"

        echo "Regen watcher: ${filename} regenerated successfully"

    done

}

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

###############################################
# Scenario 1: Existing unused auth files found
###############################################

# For every existing unused auto file, check if the user is in the system
current_users=$(getent passwd | cut -d: -f1)
for auth_file in "$PASSWORD_DIR"/*.password; do
    if [[ -f "$auth_file" ]]; then
        username=$(basename "$auth_file" .password)
        if ! echo "$current_users" | grep -q "^${username}$"; then
            echo "Found existing unused auth file for user ${username}, this should never happen"
            useradd -M -s /usr/sbin/nologin "${username}"
            password=$(cat "$auth_file")
            echo "${username}:${password}" | chpasswd
            echo "Recreated user ${username} from existing auth file."
        fi
    fi
done

# Check if there are any unused auth files based on /$PASSWORD_DIR/*.password if so, skip user generation
existing_auth_files_count=$(ls -1 $PASSWORD_DIR/*.password 2>/dev/null | wc -l)
if (( existing_auth_files_count > 0 )); then
    echo "Found ${existing_auth_files_count} unused auth files in ${PASSWORD_DIR}, skipping user generation."
    echo "Total user count on system: $( getent passwd | wc -l )"

    # Prepare the regen request directory and start the watcher in the background
    mkdir -p "${REGEN_DIR}"
    rm -f "${REGEN_DIR}"/*
    regen_watcher &

    start_dante
    exit 0
fi

###############################################
# Scenario 2: No existing auth files found
###############################################

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

# Create password directory if it doesn't exist
mkdir -p "$PASSWORD_DIR"

# Initialize progress tracking
PROGRESS_PCT_INTERVAL=10
PROGRESS_STEP_SIZE=$(( (USER_COUNT * PROGRESS_PCT_INTERVAL + 100 - 1) / 100 ))
if (( PROGRESS_STEP_SIZE == 0 )); then
    PROGRESS_STEP_SIZE=1
fi

# Before anything else, delete all non special existing users
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

# Prepare the regen request directory and start the watcher in the background
mkdir -p "${REGEN_DIR}"
rm -f "${REGEN_DIR}"/*
regen_watcher &

start_dante