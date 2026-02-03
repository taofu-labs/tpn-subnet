import { log } from "mentie"
import { with_lock } from "../locks.js"
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
 * Attempts to allocate a WireGuard lease ID atomically within the lock
 * @param {Object} params
 * @param {number} params.start_id - Starting ID range
 * @param {number} params.end_id - Ending ID range
 * @param {number} params.expires_at - Lease expiration timestamp
 * @returns {Promise<number|null>} The allocated ID, or null if pool exhausted
 */
async function attempt_wireguard_lease_allocation( { start_id, end_id, expires_at } ) {

    return with_lock( `register_wireguard_lease`, async () => {

        const pool = await get_pg_pool()

        // Find first available ID using generate_series (single query instead of 254 queries)
        const find_available_query = `
            SELECT gs.id AS available_id
            FROM generate_series( $1::int, $2::int ) AS gs( id )
            WHERE NOT EXISTS (
                SELECT 1 FROM worker_wireguard_configs wc WHERE wc.id = gs.id
            )
            ORDER BY gs.id ASC
            LIMIT 1
        `
        const result = await pool.query( find_available_query, [ start_id, end_id ] )
        const { available_id: next_available_id=null } = result.rows[0] || {}

        log.debug( `Found available ID: ${ next_available_id }` )

        if( !next_available_id ) return null

        // Reserve the ID immediately
        await pool.query( `
            INSERT INTO worker_wireguard_configs ( id, expires_at, updated_at )
            VALUES ( $1, $2, NOW() )
            ON CONFLICT ( id ) DO UPDATE
            SET expires_at = $2, updated_at = NOW()
        `, [ next_available_id, expires_at ] )

        log.info( `Allocated WireGuard lease ID ${ next_available_id }` )
        return next_available_id

    }, { timeout_ms: 60_000 } )

}

/**
 * Finds and registers a free WireGuard lease ID in the database.
 *
 * @param {Object} params - The parameters for the function.
 * @param {number} [params.start_id=1] - The starting ID to check for availability
 * @param {number} [params.end_id=250] - The ending ID to check for availability
 * @param {string} params.expires_at - The expiration date for the WireGuard lease
 * @returns {Promise<number>} The allocated WireGuard lease ID
 * @throws {Error} If no available WireGuard config slots are found
 */
export async function register_wireguard_lease( { start_id=1, end_id=WIREGUARD_PEER_COUNT, expires_at } ) {

    log.info( `Registering WireGuard lease between ${ start_id } and ${ end_id }, expires at ${ expires_at }`, new Date( expires_at ) )

    // First attempt: try to allocate without cleanup
    let allocated_id = await attempt_wireguard_lease_allocation( { start_id, end_id, expires_at } )

    // If pool exhausted, run cleanup OUTSIDE the lock and retry
    if( !allocated_id ) {

        log.info( `No available WireGuard IDs, running cleanup outside lock` )
        await cleanup_expired_wireguard_configs()

        // Second attempt after cleanup
        allocated_id = await attempt_wireguard_lease_allocation( { start_id, end_id, expires_at } )

    }

    // If still no ID available, throw with diagnostic info
    if( !allocated_id ) {

        const pool = await get_pg_pool()
        const soonest_expiry = await pool.query( `SELECT expires_at FROM worker_wireguard_configs ORDER BY expires_at ASC LIMIT 1` )
        const { expires_at: soonest_expiry_at=0 } = soonest_expiry.rows[0] || {}
        const soonest_expiry_s = ( soonest_expiry_at - Date.now() ) / 1000

        log.warn( `No available WireGuard config slots found between ${ start_id } and ${ end_id }, soonest expiry in ${ Math.floor( soonest_expiry_s / 60 ) } minutes (${ soonest_expiry_s }s)` )
        throw new Error( `No available WireGuard config slots found between ${ start_id } and ${ end_id }` )

    }

    // Wait for wireguard server OUTSIDE the lock
    log.info( `Waiting for wireguard server to be ready for id ${ allocated_id } (expires at ${ new Date( expires_at ).toISOString() })` )
    await wireguard_server_ready( { grace_window_ms: 30_000, peer_id: allocated_id } )

    return allocated_id

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