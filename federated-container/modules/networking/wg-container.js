import { abort_controller, cache, log, make_retryable, wait } from "mentie"
import { promises as fs } from "fs"
import { join } from "path"
import { exec } from "child_process"
import { mark_config_as_free, register_wireguard_lease } from '../database/worker_wireguard.js'
import { run } from "../system/shell.js"
const { dirname } = import.meta
const wireguard_folder = join( dirname, '../../', 'wg_configs' )
const { CI_MODE, CI_MOCK_WG_CONTAINER, WIREGUARD_PEER_COUNT=254 } = process.env
const wireguard_container_config_folder = '/config'

/**
 * Checks if the WireGuard server is reachable on its public IP and port.
 * @returns {Promise<boolean>} - A promise that resolves to true if the WireGuard server is reachable, false otherwise.
 */
export async function check_if_wg_reachable() {

    try {

        // Run netcat command to check if we can reach the wg container on the public ip
        const { WIREGUARD_SERVERPORT, SERVER_PUBLIC_HOST } = process.env
        if( !WIREGUARD_SERVERPORT ) throw new Error( 'WIREGUARD_SERVERPORT not set' )
        if( !SERVER_PUBLIC_HOST ) throw new Error( 'SERVER_PUBLIC_HOST not set' )
        const command = `nc -vzu -w 10 ${ SERVER_PUBLIC_HOST } ${ WIREGUARD_SERVERPORT }`
        log.info( `Checking if wireguard is reachable with command: ${ command }` )
        const { stdout, stderr } = await run( command )
        const outputs = `stdout: ${ stdout }, stderr: ${ stderr }`
        const reachable = outputs.includes( 'succeeded' )
        log.info( `Wireguard reachable: ${ reachable }. ${ outputs }` )
        return reachable


    } catch ( e ) {
        log.error( `Error in check_if_wg_reachable:`, e )
        return false
    }

}

/**
 * Waits until the WireGuard port is reachable or until the maximum wait time is exceeded.
 * @param {Object} params - The parameters for the function.
 * @param {number} [params.max_wait_ms=120000] - The maximum time in milliseconds to wait.
 * @returns {Promise<boolean>} - A promise that resolves to true if the WireGuard port becomes reachable within the grace period, or false otherwise.
 * */
export async function wait_for_wg_port_to_be_reachable( { max_wait_ms=Infinity }={} ) {

    // Time tracking
    const start = Date.now()
    let time_passed = 0
    log.info( `Waiting for wireguard port to be reachable, max wait time ${ max_wait_ms }ms` )

    // Wait for count
    let reachable = await check_if_wg_reachable()
    while( !reachable && time_passed < max_wait_ms ) {
        log.info( `Wireguard port not reachable, waiting...` )
        await wait( 5_000 )
        reachable = await check_if_wg_reachable()
        time_passed = Date.now() - start
    }

    // Return if we reached the count
    return reachable

}

/**
 * Asynchronously checks if the Wireguard server is ready by ensuring the necessary folders and configuration file exist.
 *
 * @param {number} [grace_window_ms=5000] - The maximum time in milliseconds to wait for the server readiness.
 * @param {number} [polling_speed_ms=1000] - The interval in milliseconds between readiness checks.
 * @returns {Promise<boolean>} A promise that resolves to true if the server becomes ready within the grace period, or false otherwise.
 */
export async function wireguard_server_ready( grace_window_ms=5_000, polling_speed_ms=1000, peer_id=1 ) {

    const start = Date.now()
    let time_passed = 0
    const ready_file = join( wireguard_folder, '.wg_ready' )
    const config_path = join( wireguard_folder, `peer${ peer_id }`, `peer${ peer_id }.conf` )
    log.info( `Checking if wireguard server is ready for peer${ peer_id } at ${ config_path }` )
    if( CI_MODE === 'true' && CI_MOCK_WG_CONTAINER === 'true' ) {
        log.info( `🤡 Mocking wireguard server container` )
        return true
    }

    while( time_passed < grace_window_ms ) {

        try {

            // Check if wireguard folder exists
            log.info( `Checking if wireguard folder exists at ${ wireguard_folder }` )
            const folder_exists = await fs.stat( wireguard_folder ).catch( e => false )
            if( !folder_exists ) throw new Error( 'Wireguard folder does not exist' )

            // Check if the container has finished generating configs
            log.info( `Checking for ready file at ${ ready_file }` )
            const container_ready = await fs.stat( ready_file ).then( () => true ).catch( () => false )
            if( !container_ready ) throw new Error( 'Wireguard container still generating configs' )

            // Check if the specific peer config exists (when peer_id is provided)
            const has_config = await fs.stat( config_path ).catch( e => false )
            if( !has_config ) throw new Error( 'Wireguard config does not exist' )

            return true

        } catch ( e ) {

            log.info( `Wireguard server not ready: ${ e.message }` )

        }

        // Pause
        log.info( `Waiting for ${ polling_speed_ms }ms` )
        await wait( polling_speed_ms )
        time_passed = Date.now() - start

    }

    return false

}

/**
 * Counts the number of existing WireGuard configuration files.
 * @param {number} [max_count=255] - The maximum number of configuration files to check.
 * @returns {Promise<number>} - A promise that resolves to the count of existing WireGuard configuration files.
 */
export async function count_wireguard_configs( max_count=WIREGUARD_PEER_COUNT ) {

    // Check for cached value
    const cache_key = 'wireguard_config_count'
    const cached_count = cache( cache_key )
    if( cached_count ) {
        log.info( `Returning cached count: ${ cached_count }` )
        return cached_count
    }

    let count = 0
    for( let i = 1; i <= max_count; i++ ) {
        const folder_exists = await fs.stat( join( wireguard_folder, `peer${ i }`, `peer${ i }.conf` ) ).catch( e => {
            if( e.code !== 'ENOENT' ) log.error( `Error in count_wireguard_configs:`, e )
            return false
        } )
        if( folder_exists ) count++
    }

    // Cache the count for 10 seconds
    log.info( `Caching count: ${ count }` )
    return cache( cache_key, count, 10_000 )

}

/**
 * Waits until the number of WireGuard configurations reaches the specified count or until the maximum wait time is exceeded.
 * @param {Object} params - The parameters for the function.
 * @param {number} [params.count=WIREGUARD_PEER_COUNT] - The target number of WireGuard configurations to wait for.
 * @param {number} [params.max_wait_ms=Infinity] - The maximum time in milliseconds to wait.
 * @returns {Promise<boolean>} - A promise that resolves to true if the target count is reached, or false if the maximum wait time is exceeded.
 */
export async function wait_for_wireguard_config_count( { count=WIREGUARD_PEER_COUNT, max_wait_ms=Infinity }={} ) {

    // Time tracking
    const start = Date.now()
    let time_passed = 0
    log.info( `Waiting for wireguard config count to reach ${ count }, max wait time ${ max_wait_ms }ms` )

    // Wait for count
    let current_count = await count_wireguard_configs( count )
    while( current_count < count && time_passed < max_wait_ms ) {
        log.info( `Current wireguard config count ${ current_count } is less than expected total count of ${ count }, waiting...` )
        await wait( 5_000 )
        current_count = await count_wireguard_configs( count )
        time_passed = Date.now() - start
    }

    // Return if we reached the count
    return current_count >= count

}

/**
 * Deletes WireGuard configurations for the given IDs.
 *
 * @param {Array<number>} ids - An array of IDs for which the WireGuard configurations should be deleted.
 * @returns {Promise<void>} A promise that resolves when the configurations have been deleted.
 * @throws Will log an error message if the deletion process fails.
 */
export async function delete_wireguard_configs( ids=[] ) {

    if( CI_MODE === 'true' && CI_MOCK_WG_CONTAINER === 'true' ) {
        log.info( `🤡 Mocked WG container, not deleting anything` )
        return true
    }

    try {
        // Delete all configs
        const folder_paths = ids.map( id => join( wireguard_folder, `peer${ id }` ) )
        log.info( `Deleting wireguard configs: ${ ids.join( ', ' ) }` )
        await Promise.allSettled( folder_paths.map( path => fs.rm( path, { recursive: true } ) ) )
        log.info( `Deleted wireguard configs: ${ ids.join( ', ' ) }` )
    } catch ( e ) {
        log.error( `Error in delete_wireguard_configs:`, e )
    }

}


/**
 * Executes a command in the wireguard docker container.
 * @param {string} command - The command to execute inside the container.
 * @returns {Promise<{stdout: string|null, stderr: string|null, error: Error|null}>}
 */
async function exec_in_wireguard_container( command ) {
    const docker_command = `docker exec wireguard ${ command }`
    log.debug( `Executing in wireguard container: ${ command }` )
    const result = await run( docker_command )
    const { stdout, stderr, error } = result
    if( error ) log.info( `Error executing command in wireguard container:`, { command, error, stderr, stdout } )
    return result
}

/**
 * Generates new wireguard keys (private key, public key, and preshared key).
 * @returns {Promise<{private_key: string, public_key: string, preshared_key: string}>}
 */
async function generate_wireguard_keys() {

    // Generate private key and derive public key
    const { stdout: private_key_raw } = await exec_in_wireguard_container( 'wg genkey' )
    const private_key = private_key_raw?.trim()
    if( !private_key ) throw new Error( 'Failed to generate private key' )

    // Generate public key from private key
    const { stdout: public_key_raw } = await exec_in_wireguard_container( `bash -c "echo '${ private_key }' | wg pubkey"` )
    const public_key = public_key_raw?.trim()
    if( !public_key ) throw new Error( 'Failed to generate public key' )

    // Generate preshared key
    const { stdout: preshared_key_raw } = await exec_in_wireguard_container( 'wg genpsk' )
    const preshared_key = preshared_key_raw?.trim()
    if( !preshared_key ) throw new Error( 'Failed to generate preshared key' )

    return { private_key, public_key, preshared_key }
}

/**
 * Replaces the keys in a wireguard config to invalidate existing connections.
 * This updates the config file, the running interface, and marks the config as available.
 * If any step fails, the old keys and config are restored.
 * 
 * @param {Object} params
 * @param {number} params.peer_id - The peer ID corresponding to the config (e.g., 1 for peer1)
 * @returns {Promise<{success: boolean, new_keys?: {private_key: string, public_key: string, preshared_key: string}}>}
 */
export async function replace_wireguard_config( { peer_id } ) {

    if( CI_MODE === 'true' && CI_MOCK_WG_CONTAINER === 'true' ) {
        log.info( `🤡 Mocking wireguard config replacement for peer${ peer_id }` )
        await mark_config_as_free( { peer_id } )
        return { success: true, new_keys: { private_key: `mock`, public_key: `mock`, preshared_key: `mock` } }
    }

    // Store original state for rollback
    let original_config = null
    let original_private_key = null
    let original_public_key = null
    let original_preshared_key = null
    let original_server_config = null
    let interface_modified = false

    const peer_folder = `peer${ peer_id }`
    const peer_config_path = join( wireguard_folder, peer_folder, `${ peer_folder }.conf` )
    const container_peer_folder = `${ wireguard_container_config_folder }/${ peer_folder }`
    const server_config_path = `${ wireguard_container_config_folder }/wg_confs/wg0.conf`

    /**
     * Restores the original keys and config if replacement fails.
     */
    const rollback = async () => {
        log.warn( `Rolling back wireguard config changes for peer${ peer_id }` )

        try {
            // Restore key files in the container
            if( original_private_key ) {
                await exec_in_wireguard_container( `bash -c "echo '${ original_private_key }' > ${ container_peer_folder }/privatekey-${ peer_folder }"` )
            }
            if( original_public_key ) {
                await exec_in_wireguard_container( `bash -c "echo '${ original_public_key }' > ${ container_peer_folder }/publickey-${ peer_folder }"` )
            }
            if( original_preshared_key ) {
                await exec_in_wireguard_container( `bash -c "echo '${ original_preshared_key }' > ${ container_peer_folder }/presharedkey-${ peer_folder }"` )
            }

            // Restore client config file
            if( original_config ) {
                await fs.writeFile( peer_config_path, original_config, 'utf8' )
            }

            // Restore the running interface if it was modified
            if( interface_modified && original_public_key ) {
                // Remove any new peer that might have been added
                const { stdout: current_public_key_raw } = await exec_in_wireguard_container( `cat ${ container_peer_folder }/publickey-${ peer_folder }` )
                const current_public_key = current_public_key_raw?.trim()
                if( current_public_key && current_public_key !== original_public_key ) {
                    await exec_in_wireguard_container( `wg set wg0 peer ${ current_public_key } remove` ).catch( () => {} )
                }

                // Re-add the original peer
                const address_match = original_config?.match( /Address\s*=\s*([^\n]+)/ )
                const client_ip = address_match?.[1]?.trim()
                if( client_ip ) {
                    const client_ip_cidr = client_ip.includes( '/' ) ? client_ip : `${ client_ip }/32`
                    const preshared_key_file = `${ container_peer_folder }/presharedkey-${ peer_folder }`
                    await exec_in_wireguard_container( 
                        `wg set wg0 peer ${ original_public_key } preshared-key ${ preshared_key_file } allowed-ips ${ client_ip_cidr }` 
                    )
                }
            }

            // Restore server config
            if( original_server_config ) {
                const escaped_config = original_server_config.replace( /\\/g, '\\\\' ).replace( /"/g, '\\"' ).replace( /\$/g, '\\$' )
                await exec_in_wireguard_container( `bash -c "echo \\"${ escaped_config }\\" > ${ server_config_path }"` )
            }

            log.info( `Rollback complete for peer${ peer_id }` )
        } catch ( rollback_error ) {
            log.error( `Error during rollback for peer${ peer_id }:`, rollback_error )
        }
    }

    try {

        log.info( `Replacing wireguard config for peer${ peer_id }` )

        // Read and store the current config for rollback
        original_config = await fs.readFile( peer_config_path, 'utf8' )
        log.debug( `Current config for peer${ peer_id }:`, original_config )

        // Extract the Address (client IP) from the current config
        const address_match = original_config.match( /Address\s*=\s*([^\n]+)/ )
        const client_ip = address_match?.[1]?.trim()
        if( !client_ip ) throw new Error( `Could not extract Address from peer${ peer_id } config` )

        // Store original keys from the container for rollback
        const { stdout: old_private_key_raw } = await exec_in_wireguard_container( `cat ${ container_peer_folder }/privatekey-${ peer_folder }` )
        original_private_key = old_private_key_raw?.trim()

        const { stdout: old_public_key_raw } = await exec_in_wireguard_container( `cat ${ container_peer_folder }/publickey-${ peer_folder }` )
        original_public_key = old_public_key_raw?.trim()
        log.debug( `Old public key for peer${ peer_id }: ${ original_public_key }` )

        const { stdout: old_preshared_key_raw } = await exec_in_wireguard_container( `cat ${ container_peer_folder }/presharedkey-${ peer_folder }` )
        original_preshared_key = old_preshared_key_raw?.trim()

        // Store original server config for rollback
        const { stdout: server_config_raw } = await exec_in_wireguard_container( `cat ${ server_config_path }` )
        original_server_config = server_config_raw

        // Generate new keys
        log.info( `Generating new keys for peer${ peer_id }` )
        const { private_key, public_key, preshared_key } = await generate_wireguard_keys()
        log.info( `Generated new keys for peer${ peer_id }` )

        // Update the key files in the container
        await exec_in_wireguard_container( `bash -c "echo '${ private_key }' > ${ container_peer_folder }/privatekey-${ peer_folder }"` )
        await exec_in_wireguard_container( `bash -c "echo '${ public_key }' > ${ container_peer_folder }/publickey-${ peer_folder }"` )
        await exec_in_wireguard_container( `bash -c "echo '${ preshared_key }' > ${ container_peer_folder }/presharedkey-${ peer_folder }"` )
        log.info( `Updated key files for peer${ peer_id }` )

        // Update the client config file with new keys
        let updated_config = original_config
            .replace( /PrivateKey\s*=\s*[A-Za-z0-9+/=]+/, `PrivateKey = ${ private_key }` )
            .replace( /PresharedKey\s*=\s*[A-Za-z0-9+/=]+/, `PresharedKey = ${ preshared_key }` )
        await fs.writeFile( peer_config_path, updated_config, 'utf8' )
        log.info( `Updated client config file for peer${ peer_id }` )

        // Update the running wireguard interface by removing old peer and adding new one
        // First remove the old peer using the old public key
        if( original_public_key ) {
            log.info( `Removing old peer ${ peer_id } from wg0 interface` )
            await exec_in_wireguard_container( `wg set wg0 peer ${ original_public_key } remove` )
            interface_modified = true
        }

        // Add the new peer with new keys using the preshared key file we just wrote
        log.info( `Adding new peer ${ peer_id } to wg0 interface` )
        const client_ip_cidr = client_ip.includes( '/' ) ? client_ip : `${ client_ip }/32`
        const preshared_key_file = `${ container_peer_folder }/presharedkey-${ peer_folder }`
        await exec_in_wireguard_container( 
            `wg set wg0 peer ${ public_key } preshared-key ${ preshared_key_file } allowed-ips ${ client_ip_cidr }` 
        )

        // Update the server config file (wg0.conf) for persistence across restarts
        if( original_server_config && original_public_key && original_preshared_key ) {

            // Replace the old keys with the new ones in the server config
            let updated_server_config = original_server_config
                .replace( new RegExp( `PublicKey\\s*=\\s*${ original_public_key.replace( /[+/=]/g, '\\$&' ) }` ), `PublicKey = ${ public_key }` )
                .replace( 
                    new RegExp( `(# ${ peer_folder }[\\s\\S]*?)PresharedKey\\s*=\\s*[A-Za-z0-9+/=]+` ), 
                    `$1PresharedKey = ${ preshared_key }` 
                )
                .replace( new RegExp( `PresharedKey\\s*=\\s*${ original_preshared_key.replace( /[+/=]/g, '\\$&' ) }` ), `PresharedKey = ${ preshared_key }` )

            // Write updated server config
            const escaped_config = updated_server_config.replace( /\\/g, '\\\\' ).replace( /"/g, '\\"' ).replace( /\$/g, '\\$' )
            await exec_in_wireguard_container( `bash -c "echo \\"${ escaped_config }\\" > ${ server_config_path }"` )
            log.info( `Updated server config file (wg0.conf)` )

        } else {
            throw new Error( `Missing original config data for peer${ peer_id }: server_config=${ !!original_server_config }, public_key=${ !!original_public_key }, preshared_key=${ !!original_preshared_key }` )
        }

        // Mark the config as available in the database
        await mark_config_as_free( { peer_id } )
        log.info( `Marked peer${ peer_id } config as free in database` )

        return { success: true, new_keys: { private_key, public_key, preshared_key } }

    } catch ( e ) {

        log.error( `Error in replace_wireguard_config for peer${ peer_id }:`, e )
        await rollback()
        return { success: false }

    }

}

/**
 * Replaces wireguard configs for multiple peers to invalidate existing connections.
 * If an empty array is provided, all existing configs will be replaced.
 * 
 * @param {Object} params
 * @param {Array<number>} [params.peer_ids=[]] - Array of peer IDs to replace. If empty, replaces all configs.
 * @returns {Promise<{success: boolean, results: Array<{peer_id: number, success: boolean}>}>}
 */
export async function replace_wireguard_configs( { peer_ids=[] }={} ) {

    try {

        // If no peer IDs provided, get all existing config IDs
        let ids_to_replace = peer_ids
        if( !ids_to_replace.length ) {
            log.info( `No peer IDs specified, replacing all wireguard configs` )
            const config_count = await count_wireguard_configs()
            ids_to_replace = Array.from( { length: config_count }, ( _, i ) => i + 1 )
        }

        log.info( `Replacing wireguard configs for peers: ${ ids_to_replace.join( ', ' ) }` )

        // Replace each config sequentially to avoid race conditions
        const results = []
        for( const peer_id of ids_to_replace ) {
            const result = await replace_wireguard_config( { peer_id } )
            results.push( { peer_id, success: result.success } )
        }

        // Check if all replacements succeeded
        const all_success = results.every( r => r.success )
        const failed_count = results.filter( r => !r.success ).length

        if( all_success ) {
            log.info( `Successfully replaced all ${ results.length } wireguard configs` )
        } else {
            log.warn( `Replaced wireguard configs with ${ failed_count }/${ results.length } failures` )
        }

        return { success: all_success, results }

    } catch ( e ) {

        log.error( `Error in replace_wireguard_configs:`, e )
        return { success: false, results: [] }

    }

}

/**
 * Restart the WireGuard container.
 * 
 * This function attempts to restart a Docker container named "wireguard".
 * It logs the result if successful, and logs an error if the restart fails.
 * 
 * @async
 * @function restart_wg_container
 * @returns {Promise<void>} A promise that resolves when the container is restarted.
 * @throws Will throw an error if the Docker command fails.
 */
export async function restart_wg_container() {

    // Restart the wireguard container, note that this relies on the container being named "wireguard"
    try {
        log.info( `Restarting wireguard container` )
        if( CI_MODE === 'true' && CI_MOCK_WG_CONTAINER === 'true' ) {
            log.info( `🤡 Mocking wireguard server container restart` )
            return true
        }
        const result = await new Promise( ( resolve, reject ) => {
            exec( `docker restart wireguard`, ( error, stdout, stderr ) => {
                if( error ) return reject( error )
                if( stderr ) return reject( stderr )
                resolve( stdout )
            } )
        } )
        log.info( `Restarted wireguard container`, result )
    } catch ( e ) {
        log.error( `Error in restart_wg_container:`, e )
    }
}


/**
 * Retrieves a valid WireGuard configuration.
 *
 * @param {Object} options - The options for the WireGuard configuration.
 * @param {Object} [options.priority=false] - Whether to use one of the priority slots
 * @param {number} [options.lease_seconds=60] - The lease duration in seconds.
 * @param {string} [options.feedback_url] - URL to check with validator what the request status is
 * @returns {Promise<Object>} A promise that resolves to an object containing the WireGuard configuration.
 * @returns {string} return.peer_config - The WireGuard peer configuration.
 * @returns {number} return.peer_id - The ID of the registered WireGuard lease.
 * @returns {number} return.peer_slots - The number of WireGuard peer slots.
 * @returns {number} return.expires_at - The expiration timestamp of the lease.
 */
export async function get_valid_wireguard_config( { priority=false, lease_seconds=60, feedback_url } ) {

    // Check if wireguard server is ready
    const wg_ready = await wireguard_server_ready()
    log.info( `Wireguard server ready: ${ wg_ready }` )
    
    // Count amount of wireguard configs
    log.info( 'Counting wireguard configs' )
    const peer_slots = await count_wireguard_configs()

    // Formulate config parameters
    const expires_at = Date.now() + lease_seconds * 1000
    const { PRIORITY_SLOTS: priority_slots = 5 } = process.env
    let safe_start = Number( priority_slots ) + 1
    if( safe_start > peer_slots ) safe_start = 1
    const config_parameters = {
        expires_at,
        end_id: peer_slots,
        start_id: priority ? 1 : safe_start,
    }
    
    // Get a valid wireguard config slot
    log.info( `Requesting wireguard lease with:`, config_parameters )
    const peer_id = await register_wireguard_lease( config_parameters )
    log.info( `Registered wireguard lease with ID ${ peer_id }` )
    
    // Read the peer config file
    log.info( `Reading peer${ peer_id } config file` )
    const read_config = async () => {
        const peer_path = `${ wireguard_folder }/peer${ peer_id }/peer${ peer_id }.conf`
        log.info( `Reading file at path: ${ peer_path }` )
        const file = await fs.readFile( peer_path, 'utf8' )
        log.info( 'Read file: ', file )
        return file
    }
    const retryable_read = await make_retryable( read_config, {
        retry_times: CI_MODE === 'true' ? 0 : 2,
        cooldown_in_s: 5,
        logger: log.info
    } )
    const wireguard_config = await retryable_read()
    log.info( `Read peer${ peer_id }.conf config file` )

    // If feedback url was provided, use it to check if validator already was served
    if( feedback_url ) {

        // Decode url 
        feedback_url = decodeURIComponent( feedback_url )

        // First check what the request status is
        const { fetch_options } = abort_controller( { timeout_ms: 10_000 } )
        const { status } = await fetch( feedback_url, fetch_options ).then( r => r.json() ).catch( e => {
            log.warn( `Failed to fetch feedback URL ${ feedback_url } to check request status (suggests validator misconfiguration):`, e )
            return {}
        } )

        // If status is complete, clear this config as free again
        if( status === 'complete' ) {
            log.info( `Lease request already marked as complete according to feedback URL ${ feedback_url }, marking config as free again` )
            await mark_config_as_free( { peer_id } )
            return { cancelled: true }
        }

    }

    return { wireguard_config, peer_id, peer_slots, expires_at }
    
}