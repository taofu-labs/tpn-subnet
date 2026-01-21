import { cache, log, wait } from "mentie"
import { get_pg_pool } from "./postgres.js"
import { delete_wireguard_configs, replace_wireguard_configs, restart_wg_container, wireguard_server_ready } from "../networking/wg-container.js"
const { WIREGUARD_PEER_COUNT=254, BETA_REFRESH_LEASE_INSTEAD_OF_DELETE } = process.env 

async function cleanup_expired_wireguard_configs() {

    // Get pool
    const pool = await get_pg_pool()

    // Find all expired rows
    log.info( 'Checking for expired rows' )
    const expired_rows = await pool.query( `SELECT id FROM worker_wireguard_configs WHERE expires_at < $1`, [ Date.now() ] )
    log.debug( `Expired rows: ${ expired_rows.rows.map( row => row.id ).join( ', ' ) }` ) 
    // Delete all expired rows and their associated configs
    const expired_ids = expired_rows.rows.map( row => row.id )
    log.debug( `Expired ids: ${ expired_ids.length } of ${ WIREGUARD_PEER_COUNT }` )
    if( BETA_REFRESH_LEASE_INSTEAD_OF_DELETE !== 'true' && expired_ids.length > 0 ) {

        log.info( `${ expired_ids.length } WireGuard configs have expired, deleting them and restarting server` )

        // Delete and restart the wireguard server
        await delete_wireguard_configs( expired_ids )

        // Check if there are open leases remaining
        const open_leases = await check_open_leases()
        log.debug( `Open leases after cleanup: ${ open_leases.length }` )
        if( !open_leases.length ) await restart_wg_container()
        else log.info( `Not restarting wg container as there are still ${ open_leases.length } open leases` )

        // Delete the expired rows from the database
        await pool.query( `DELETE FROM worker_wireguard_configs WHERE id = ANY( $1::int[] )`, [ expired_ids ] )

    }

    // Beta approach, just replace config keys in memory to prevent restarts
    if( BETA_REFRESH_LEASE_INSTEAD_OF_DELETE === 'true' && expired_ids.length > 0 ) {

        log.info( `${ expired_ids.length } WireGuard configs have expired, refreshing their keys in memory` )

        // Replace the configs in memory
        await replace_wireguard_configs( { peer_ids: expired_ids } )
        log.info( `Refreshed WireGuard configs for expired leases: ${ expired_ids.join( ', ' ) }` )
        
        // Delete the expired rows from the database
        await pool.query( `DELETE FROM worker_wireguard_configs WHERE id = ANY( $1::int[] )`, [ expired_ids ] )

    }

}

/**
 * Finds and registers a free WireGuard lease ID in the database.
 *
 * @param {Object} params - The parameters for the function.
 * @param {number} [params.start_id=1] - The starting ID to check for availability, starts at 1
 * @param {number} [params.end_id=250] - The ending ID to check for availability.
 * @param {string} params.expires_at - The expiration date for the WireGuard lease.
 * @returns {Promise<Object>} result - A promise that resolves to an object containing the next available ID and whether the ID was recycled
 * @returns {number} result.next_available_id - The next available ID for the WireGuard lease.
 * @returns {boolean} result.recycled - Whether the ID was recycled from an expired lease.
 * @throws {Error} If no available WireGuard config slots are found within the specified range.
 */
export async function register_wireguard_lease( { start_id=1, end_id=WIREGUARD_PEER_COUNT, expires_at } ) {

    try {
        log.info( `Registering WireGuard lease between ${ start_id } and ${ end_id }, expires at ${ expires_at }`, new Date( expires_at ) )

        // Get postgres pool
        const pool = await get_pg_pool()

        // Mitigate race contitions
        let working = cache( `register_wireguard_lease_working` )
        while( working ) {
            log.debug( `Waiting for register_wireguard_lease to finish`, working )
            await wait( 1000 )
            working = cache( `register_wireguard_lease_working` )
            log.debug( `Working: ${ working }` )
        }
        log.debug( `Starting register_wireguard_lease` )
        cache( `register_wireguard_lease_working`, true, 10_000 )

        // Check if there is an id that does not yet exist between the start and end id
        log.debug( `Checking for available id between ${ start_id } and ${ end_id }` )
        let id = start_id
        let cleaned_up = false
        while( id <= end_id ) {

            // Check for a non-existing id row (meaning unassigned and free)
            const existing_id = await pool.query( `SELECT id FROM worker_wireguard_configs WHERE id = $1`, [ id ] )
            if( !existing_id.rows.length ) break
            id++

            // If we have reached the end of the range and did not clean up yet, clean up and start over
            if( id > end_id && !cleaned_up ) {
                await cleanup_expired_wireguard_configs()
                cleaned_up = true
                id = start_id
            }

        }
        let next_available_id = id > end_id ? null : id
        log.info( `Next available empty id: ${ next_available_id }` )

        // If no available id was found, throw an error
        if( !next_available_id ) {

            // Find the expiry timestamp of the row that expires soonest
            const soonest_expiry = await pool.query( `SELECT expires_at FROM worker_wireguard_configs ORDER BY expires_at ASC LIMIT 1` )
            const { expires_at: soonest_expiry_at=0 } = soonest_expiry.rows[0] || {}
            const soonest_expiry_s = ( soonest_expiry_at - Date.now() ) / 1000

            log.warn( `No available WireGuard config slots found between ${ start_id } and ${ end_id }, soonest expiry in ${ Math.floor( soonest_expiry_s / 60 ) } minutes (${ soonest_expiry_s }s)` )
            cache( `register_wireguard_lease_working`, false )
            throw new Error( `No available WireGuard config slots found between ${ start_id } and ${ end_id }` )
        }

        // Insert the new row, make sure that existing rows are updated and not appended
        await pool.query( `
            INSERT INTO worker_wireguard_configs ( id, expires_at, updated_at )
            VALUES ( $1, $2, NOW() )
            ON CONFLICT ( id ) DO UPDATE
            SET expires_at = $2, updated_at = NOW()
        `, [ next_available_id, expires_at ] )

        // Clear the working cache
        log.debug( `Finished register_wireguard_lease` )
        cache( `register_wireguard_lease_working`, false )

        // Wait for wireguard server to be ready for this config
        log.info( `Waiting for wireguard server to be ready for id ${ next_available_id } (expires at ${ new Date( expires_at ).toISOString() })` )
        await wireguard_server_ready( 30_000, next_available_id )

        return next_available_id
        
    } finally {
        cache( `register_wireguard_lease_working`, false )
    }

}

/**
 * Checks for open WireGuard leases in the database.
 * @returns {Promise<Array>} A promise that resolves to an array of open lease objects.
 */
export async function check_open_leases() {

    try {

        // Get pool
        const pool = await get_pg_pool()

        // Find all open leases
        log.info( 'Checking for open leases' )
        const open_leases = await pool.query( `SELECT id, expires_at FROM worker_wireguard_configs WHERE expires_at > $1 ORDER BY expires_at ASC`, [ Date.now() ] )
        if( open_leases?.rows.length ) log.debug( `Open leases: ${ open_leases.rows.length }, latest expires at ${ new Date( open_leases?.rows[0]?.expires_at || 0 ).toISOString() }` )
        else log.debug( `No open leases found` )
        return open_leases.rows

    } catch ( e ) {

        log.error( `Error in check_open_leases:`, e )
        return []
        
    }

}

/**
 * Marks a WireGuard config as free by deleting its entry from the database.
 * @param {Object} params
 * @param {number} params.peer_id - The ID of the WireGuard config to mark as free.
 */
export async function mark_config_as_free( { peer_id } ) {

    try {
        log.info( `Marking WireGuard config ${ peer_id } as free` )
        const pool = await get_pg_pool()
        await pool.query( `DELETE FROM worker_wireguard_configs WHERE id = $1`, [ peer_id ] )
    } catch ( e ) {
        log.error( `Error in mark_config_as_free:`, e )
    }
    
}