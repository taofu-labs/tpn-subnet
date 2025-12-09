import { cache, log, make_retryable, wait } from "mentie"
import { promises as fs } from "fs"
import { join } from "path"
import { exec } from "child_process"
import { mark_config_as_free, register_wireguard_lease } from '../database/worker_wireguard.js'
import { run } from "../system/shell.js"
const { dirname } = import.meta
const wireguard_folder = join( dirname, '../../', 'wg_configs' )
const { CI_MODE, CI_MOCK_WG_CONTAINER, WIREGUARD_PEER_COUNT=254 } = process.env

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
 * @returns {Promise<boolean>} A promise that resolves to true if the server becomes ready within the grace period, or false otherwise.
 */
export async function wireguard_server_ready( grace_window_ms=5_000, peer_id=1 ) {

    const start = Date.now()
    let time_passed = 0
    const config_path = join( wireguard_folder, `peer${ peer_id }`, `peer${ peer_id }.conf` )
    log.info( `Checking if wireguard server is ready for peer${ peer_id } at ${ config_path }` )
    if( CI_MODE && CI_MOCK_WG_CONTAINER ) {
        log.info( `🤡 Mocking wireguard server container` )
        return true
    }

    while( time_passed < grace_window_ms ) {

        try {

            // Check if wireguard folder exists
            log.info( `Checking if wireguard folder exists at ${ wireguard_folder }` )
            const folder_exists = await fs.stat( wireguard_folder )
            if( !folder_exists ) throw new Error( 'Wireguard folder does not exist' )

            // Check if the folder list has at least one peer folder with valid config in wireguard/peer1/peer1.conf
            const has_config = await fs.stat( config_path )
            if( !has_config ) throw new Error( 'Wireguard config does not exist' )

            return true

        } catch ( e ) {

            log.info( `Wireguard server not ready: ${ e.message }` )

        }

        // Pause
        log.info( `Waiting for ${ 1000 }ms` )
        await wait( 1000 )
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

    if( CI_MODE && CI_MOCK_WG_CONTAINER ) {
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
        if( CI_MODE && CI_MOCK_WG_CONTAINER ) {
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
 * @params {string} [options.feedback_url] - URL to check with validator what the request status is
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
    const priority_slots = 1
    let safe_start = priority_slots + 1
    if( safe_start < peer_slots ) safe_start = 1
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
        retry_times: CI_MODE ? 0 : 2,
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
        const { status } = await fetch( feedback_url ).then( r => r.json() ).catch( e => {
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