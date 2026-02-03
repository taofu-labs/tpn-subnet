import { cache, log, round_number_to_decimals, wait } from "mentie"
import { format, get_pg_pool } from "./postgres.js"
import { run } from "../system/shell.js"
import { test_socks5_connection } from "../networking/socks5.js"
import { stat } from "fs/promises"
import { dante_server_ready, load_socks5_from_disk, regenerate_dante_socks5_config } from "../networking/dante-container.js"

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

    const working_key = `get_socks5_config_working`
    const { PASSWORD_DIR = '/passwords' } = process.env

    // Offset determines which pool we select from:
    // - Priority: offset 0, select from first N configs (shared pool)
    // - Non-priority: offset N, select from configs after priority slots (exclusive)
    const offset = Number( priority ? 0 : priority_slots )

    try {

        const pool = await get_pg_pool()

        // Only non-priority needs race condition lock (priority configs are shared)
        if( !priority ) {
            let working = cache( working_key )
            while( working ) {
                log.debug( `get_socks5_config is already in progress, waiting...` )
                await wait( 1000 )
                working = cache( working_key )
            }
            cache( working_key, true )
        }

        let sock = null

        if( priority ) {

            // Priority: select from first N available configs, pick random for load distribution
            const select_query = `SELECT * FROM worker_socks5_configs WHERE available = TRUE ORDER BY id ASC LIMIT $1`
            const result = await pool.query( select_query, [ priority_slots ] )
            const priority_configs = result.rows || []

            if( !priority_configs.length ) return { success: false, error: `No priority configs available` }

            sock = priority_configs[ Math.floor( Math.random() * priority_configs.length ) ]

            // Test connection
            const sock_string = `socks5://${ sock.username }:${ sock.password }@${ sock.ip_address }:${ sock.port }`
            await dante_server_ready( { max_wait_ms: 10_000 } )
            const sock_works = await test_socks5_connection( { sock: sock_string } )

            // If test fails, regenerate password (priority socks are shared, so we fix rather than skip)
            if( !sock_works ) {
                log.warn( `Priority SOCKS5 config ${ sock.username } failed test, regenerating password` )
                const { password: new_password, error } = await regenerate_dante_socks5_config( { username: sock.username } )
                if( error ) return { success: false, error: `Failed to regenerate priority config: ${ error }` }
                sock.password = new_password
            }

            // Update expires_at only (keep available unchanged for shared configs)
            const update_query = `UPDATE worker_socks5_configs SET expires_at = $1, updated = $2 WHERE username = $3`
            await pool.query( update_query, [ expires_at, Date.now(), sock.username ] )

            log.info( `Returning priority SOCKS5 config ${ sock.username } (shared, never marked unavailable)` )

        } else {

            // Non-priority: select with offset, retry loop until we find a working sock
            let attempts = 0
            const { available_socks_count: max_attempts } = await count_available_socks( { skip_slots: offset } )

            while( attempts < max_attempts && !sock ) {

                log.info( `[WHILE] Attempt ${ attempts + 1 } to find available SOCKS5 config (skipping ${ offset } priority slots)` )

                const select_query = `SELECT * FROM worker_socks5_configs WHERE available = TRUE ORDER BY id ASC OFFSET $1 LIMIT 1`
                const result = await pool.query( select_query, [ offset ] )
                const [ available_sock ] = result.rows || []

                // If none found, cleanup expired configs and retry
                if( !available_sock ) {
                    log.warn( `No available SOCKS5 configs found, attempting to clean up expired configs` )
                    await cleanup_expired_dante_socks5_configs()
                    attempts++
                    continue
                }

                // Test connection
                const sock_string = `socks5://${ available_sock.username }:${ available_sock.password }@${ available_sock.ip_address }:${ available_sock.port }`
                await dante_server_ready( { max_wait_ms: 10_000 } )
                const sock_works = await test_socks5_connection( { sock: sock_string } )

                if( sock_works ) {
                    log.info( `Selected SOCKS5 config ${ sock_string } works locally` )
                    sock = available_sock
                    continue
                }

                // Mark broken sock as unavailable and expired
                log.warn( `Selected SOCKS5 config ${ sock_string } failed the connection test` )
                const update_query = `UPDATE worker_socks5_configs SET available = FALSE, expires_at = $1, updated = $2 WHERE username = $3 AND password = $4`
                await pool.query( update_query, [ Date.now(), Date.now(), available_sock.username, available_sock.password ] )

                // Check password file state for debugging
                const pass_file = `${ PASSWORD_DIR }/${ available_sock.username }.password`
                const pass_file_exists = await stat( pass_file ).then( () => true ).catch( () => false )
                const pass_used_file_exists = await stat( `${ pass_file }.used` ).then( () => true ).catch( () => false )
                log.warn( `Password file exists: ${ pass_file_exists }, used file exists: ${ pass_used_file_exists }` )

                // Reload configs from disk to sync with dante container state
                await load_socks5_from_disk()
                attempts++

            }

            // If no sock found after all attempts, log diagnostic info and error
            if( !sock ) {

                const select_query = `SELECT * FROM worker_socks5_configs ORDER BY expires_at ASC LIMIT 1`
                const result = await pool.query( select_query )
                const [ soonest_expiring_sock ] = result.rows || []

                if( soonest_expiring_sock ) {
                    const minutes_until_available = round_number_to_decimals( ( soonest_expiring_sock.expires_at - Date.now() ) / 60000, 2 )
                    const available_at = new Date( soonest_expiring_sock.expires_at ).toISOString()
                    log.warn( `No available SOCKS5 configs found, soonest expiring sock (${ soonest_expiring_sock.username }) expires at ${ available_at } in ${ minutes_until_available } minutes` )
                } else {
                    log.warn( `No available SOCKS5 configs found, and no socks exist in the database` )
                }

                throw new Error( `No available SOCKS5 configs found after ${ max_attempts } attempts` )
            }

            // Mark the sock as unavailable (exclusive lease)
            const update_query = `UPDATE worker_socks5_configs SET available = FALSE, expires_at = $1, updated = $2 WHERE username = $3 AND password = $4`
            await pool.query( update_query, [ expires_at, Date.now(), sock.username, sock.password ] )
            log.info( `Registered SOCKS5 lease for ${ sock.ip_address }:${ sock.port }, expires at ${ new Date( expires_at ).toISOString() }` )

            // Write .used file so dante container preserves lease state across restarts
            await run( `echo ${ expires_at } > ${ PASSWORD_DIR }/${ sock.username }.password.used` )

        }

        return { success: true, sock }

    } catch ( e ) {
        log.error( `Error in get_socks5_config:`, e )
        return { success: false, error: e.message }
    } finally {
        // Release working lock for non-priority requests
        if( !priority ) cache( working_key, false )
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

