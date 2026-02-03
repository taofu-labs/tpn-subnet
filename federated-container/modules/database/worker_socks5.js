import { log, round_number_to_decimals } from "mentie"
import { with_lock } from "../locks.js"
import { format, get_pg_pool } from "./postgres.js"
import { run } from "../system/shell.js"
import { dante_server_ready, regenerate_dante_socks5_config } from "../networking/dante-container.js"

/**
 * Gets a SOCKS5 config from the database, handling both priority and non-priority requests.
 * Priority requests use shared configs from the first N slots (never marked unavailable).
 * Non-priority requests get exclusive leases from configs after the priority slots.
 * @param {Object} params
 * @param {number} params.expires_at - Timestamp when the lease expires
 * @param {boolean} [params.priority=false] - Whether this is a priority request (uses shared configs)
 * @param {number} [params.priority_slots=5] - Number of configs reserved for priority pool
 * @returns {Promise<{ success: boolean, sock?: Object, error?: string }>}
 */
export async function get_socks5_config( { expires_at, priority = false, priority_slots = 5 } ) {

    const { PASSWORD_DIR = '/passwords' } = process.env

    // Offset determines which pool we select from:
    // - Priority: offset 0, select from first N configs (shared pool)
    // - Non-priority: offset N, select from configs after priority slots (exclusive)
    const offset = Number( priority ? 0 : priority_slots )

    // Priority requests don't need locking (shared configs), non-priority needs mutex
    if( priority ) {
        return get_socks5_config_priority( { expires_at, priority_slots } )
    }

    // Non-priority requests are wrapped in mutex to prevent race conditions
    return with_lock( `get_socks5_config`, async () => {
        return get_socks5_config_non_priority( { expires_at, offset, PASSWORD_DIR } )
    } )

}

/**
 * Gets a priority SOCKS5 config (shared pool, no locking needed)
 * @param {Object} params
 * @param {number} params.expires_at - Timestamp when the lease expires
 * @param {number} params.priority_slots - Number of configs in priority pool
 * @returns {Promise<{ success: boolean, sock?: Object, error?: string }>}
 */
async function get_socks5_config_priority( { expires_at, priority_slots } ) {

    try {

        const pool = await get_pg_pool()

        // Priority: select from first N available configs, pick random for load distribution
        const select_query = `SELECT * FROM worker_socks5_configs WHERE available = TRUE ORDER BY id ASC LIMIT $1`
        const result = await pool.query( select_query, [ priority_slots ] )
        const priority_configs = result.rows || []

        if( !priority_configs.length ) return { success: false, error: `No priority configs available` }

        const sock = priority_configs[ Math.floor( Math.random() * priority_configs.length ) ]

        // Wait for dante server ready, assume sock works (skip connection testing)
        await dante_server_ready( { max_wait_ms: 10_000 } )

        // Update expires_at only (keep available unchanged for shared configs)
        const update_query = `UPDATE worker_socks5_configs SET expires_at = $1, updated = $2 WHERE username = $3`
        await pool.query( update_query, [ expires_at, Date.now(), sock.username ] )

        log.info( `Returning priority SOCKS5 config ${ sock.username } (shared, never marked unavailable)` )

        return { success: true, sock }

    } catch ( e ) {
        log.error( `Error in get_socks5_config_priority:`, e )
        return { success: false, error: e.message }
    }

}

/**
 * Gets a non-priority SOCKS5 config (exclusive lease, called under mutex)
 * @param {Object} params
 * @param {number} params.expires_at - Timestamp when the lease expires
 * @param {number} params.offset - Number of configs to skip (priority slots)
 * @param {string} params.PASSWORD_DIR - Directory containing password files
 * @returns {Promise<{ success: boolean, sock?: Object, error?: string }>}
 */
async function get_socks5_config_non_priority( { expires_at, offset, PASSWORD_DIR } ) {

    try {

        const pool = await get_pg_pool()

        // Wait for dante server to be ready
        await dante_server_ready( { max_wait_ms: 10_000 } )

        // Select first available sock (skipping priority slots)
        const select_query = `SELECT * FROM worker_socks5_configs WHERE available = TRUE ORDER BY id ASC OFFSET $1 LIMIT 1`
        let result = await pool.query( select_query, [ offset ] )
        let sock = result.rows?.[0] || null

        // If none found, try cleanup once and retry
        if( !sock ) {

            log.info( `No available SOCKS5 configs, running cleanup` )
            await cleanup_expired_dante_socks5_configs()

            result = await pool.query( select_query, [ offset ] )
            sock = result.rows?.[0] || null

        }

        // If still no sock, return error with diagnostic info
        if( !sock ) {

            const diagnostic_query = `SELECT * FROM worker_socks5_configs ORDER BY expires_at ASC LIMIT 1`
            const diagnostic_result = await pool.query( diagnostic_query )
            const [ soonest_expiring_sock ] = diagnostic_result.rows || []

            if( soonest_expiring_sock ) {
                const minutes_until_available = round_number_to_decimals( ( soonest_expiring_sock.expires_at - Date.now() ) / 60000, 2 )
                const available_at = new Date( soonest_expiring_sock.expires_at ).toISOString()
                log.warn( `No available SOCKS5 configs, soonest (${ soonest_expiring_sock.username }) expires at ${ available_at } in ${ minutes_until_available } minutes` )
            } else {
                log.warn( `No available SOCKS5 configs, and no socks exist in the database` )
            }

            return { success: false, error: `No available SOCKS5 configs found` }

        }

        // Mark the sock as unavailable (exclusive lease)
        const update_query = `UPDATE worker_socks5_configs SET available = FALSE, expires_at = $1, updated = $2 WHERE username = $3 AND password = $4`
        await pool.query( update_query, [ expires_at, Date.now(), sock.username, sock.password ] )
        log.info( `Registered SOCKS5 lease for ${ sock.ip_address }:${ sock.port }, expires at ${ new Date( expires_at ).toISOString() }` )

        // Write .used file so dante container preserves lease state across restarts
        await run( `echo ${ expires_at } > ${ PASSWORD_DIR }/${ sock.username }.password.used` )

        return { success: true, sock }

    } catch ( e ) {
        log.error( `Error in get_socks5_config_non_priority:`, e )
        return { success: false, error: e.message }
    }

}

/**
 * Writes SOCKS5 proxy configurations to the database
 * Uses upsert (ON CONFLICT) to update existing usernames and insert new ones, then deletes missing ones
 * @param {Object} params
 * @param {Array<{ ip_address: string, port: number, username: string, password: string, available: boolean }>} params.socks - Array of SOCKS5 configurations
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export async function write_socks( { socks } ) {

    try {

        // Get pool
        const pool = await get_pg_pool()

        // Validate socks - ensure all expected properties are present
        const expected_properties = [ `ip_address`, `port`, `username`, `password`, `available` ]
        const valid_socks = socks.filter( sock => {
            const sock_props = Object.keys( sock )
            return expected_properties.every( prop => sock_props.includes( prop ) )
        } )

        log.info( `Received ${ socks.length } socks to save to db, ${ valid_socks.length } valid socks, excerpt: `, socks.slice( 0, 1 ) )

        // If no valid socks, delete all existing entries and return
        if( !valid_socks?.length ) {
            log.warn( `No valid socks to write, deleting all existing entries` )
            await pool.query( `DELETE FROM worker_socks5_configs` )
            return { success: true }
        }

        // Deduplicate by username (keep last occurrence) to avoid upsert conflicts within same batch
        const unique_socks = [ ...new Map( valid_socks.map( sock => [ sock.username, sock ] ) ).values() ]
        if( unique_socks.length !== valid_socks.length ) {
            log.warn( `Deduplicated ${ valid_socks.length } socks to ${ unique_socks.length } unique usernames` )
        }

        const now = Date.now()
        const incoming_usernames = unique_socks.map( ( { username } ) => username )

        // Upsert all socks - insert new ones, update password for existing ones (preserves available/expires_at)
        const upsert_query = format( `
            INSERT INTO worker_socks5_configs ( ip_address, port, username, password, available, updated, expires_at )
            VALUES %L
            ON CONFLICT ( username ) DO UPDATE SET
                password = EXCLUDED.password,
                updated = EXCLUDED.updated
        `, unique_socks.map( sock => [ sock.ip_address, sock.port, sock.username, sock.password, sock.available, now, 0 ] ) )
        await pool.query( upsert_query )
        log.info( `Upserted ${ unique_socks.length } SOCKS5 configs` )

        // Delete entries not in incoming list
        const delete_query = format( `
            DELETE FROM worker_socks5_configs
            WHERE username NOT IN ( %L )
        `, incoming_usernames )
        const delete_result = await pool.query( delete_query )
        const deleted_count = delete_result.rowCount || 0
        if( deleted_count ) {
            log.info( `Deleted ${ deleted_count } SOCKS5 configs not in incoming list` )
        }

        log.info( `Successfully synced ${ unique_socks.length } SOCKS5 configs` )
        return { success: true }

    } catch ( e ) {
        log.error( `Error in write_socks:`, e )
        return { success: false, error: e.message }
    }

}

/**
 * Cleans up expired SOCKS5 proxy configurations by regenerating their passwords and marking them as available
 * @returns {Promise<void>}
 */
export async function cleanup_expired_dante_socks5_configs() {

    try {

        // Get pool
        const pool = await get_pg_pool()

        // Get all the expired socks
        const now = Date.now()
        const select_query = `
            SELECT *
            FROM worker_socks5_configs
            WHERE expires_at > 0 AND expires_at <= $1
        `
        const result = await pool.query( select_query, [ now ] )
        const expired_socks = result.rows || []
        log.info( `Found ${ expired_socks.length } expired SOCKS5 configs to clean up` )

        // Regenerate passwords for these users
        const max_wait_ms = expired_socks.length * 10_000
        const regen_results = await Promise.all( expired_socks.map( ( { username } ) => regenerate_dante_socks5_config( { username, max_wait_ms } ) ) )
        const regenerated_configs = regen_results.filter( ( { error } ) => !error )
        const errored_usernames = regen_results.filter( ( { error } ) => error ).map( ( { username } ) => username )

        // Delete the errored usernames from the config list all together
        if( errored_usernames.length ) {
            log.warn( `Failed to regenerate SOCKS5 configs for usernames: ${ errored_usernames.join( ', ' ) }` )
            const delete_query = format( `
                DELETE FROM worker_socks5_configs
                WHERE username IN ( %L )
            `, errored_usernames )
            await pool.query( delete_query )
        }

        // If none regenerated, return
        if( !regenerated_configs.length ) {
            log.info( `No SOCKS5 configs were regenerated` )
            return
        }

        // Mark these socks as available, expires 0, with the updated password
        const update_query = format( `
            UPDATE worker_socks5_configs
            SET available = TRUE, expires_at = 0, password = data.password, updated = data.updated::bigint
            FROM ( VALUES %L ) AS data( username, password, updated )
            WHERE worker_socks5_configs.username = data.username
        `, regenerated_configs.map( ( { username, password } ) => [ username, password, now ] ) )
        await pool.query( update_query )

        log.info( `Cleaned up ${ expired_socks.length } expired SOCKS5 configs` )

    } catch ( e ) {
        log.error( `Error cleaning up expired SOCKS5 configs:`, e )
    }

}

/**
 * Counts the number of available SOCKS5 proxy configurations
 * @param {Object} params
 * @param {number} [params.skip_slots=0] - Number of configs to skip (by ID order) for priority reservation
 * @returns {Promise<{ success: boolean, available_socks_count?: number, error?: string }>}
 */
export async function count_available_socks( { skip_slots = 0 } = {} ) {

    try {

        // Get pool
        const pool = await get_pg_pool()

        // Query count of available socks, skipping priority slots using a subquery
        // The subquery orders by ID and skips the first N (priority) configs
        const query = `
            SELECT COUNT(*) AS available_count
            FROM (
                SELECT id FROM worker_socks5_configs
                WHERE available = TRUE
                ORDER BY id ASC
                OFFSET $1
            ) AS non_priority_socks
        `
        const result = await pool.query( query, [ Number( skip_slots ) ] )
        const available_socks_count = Number( result.rows[0]?.available_count || 0 )

        return { success: true, available_socks_count }

    } catch ( e ) {
        console.error( `Error in count_available_socks:`, e )
        return { success: false, error: e.message }
    }

}

