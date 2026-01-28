import { cache, log, wait } from "mentie"
import { format, get_pg_pool } from "./postgres.js"
import { run } from "../system/shell.js"
import { test_socks5_connection } from "../networking/socks5.js"
import { stat } from "fs/promises"
import { dante_server_ready, load_socks5_from_disk, regenerate_dante_socks5_config } from "../networking/dante-container.js"

/**
 * Writes SOCKS5 proxy configurations to the database
 * Existing usernames are updated (username + password only), new ones are inserted, missing ones are deleted
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

        log.info( `Received ${ socks.length } socks, ${ valid_socks.length } valid socks, excerpt: `, socks.slice( 0, 1 ) )

        // If no valid socks, delete all existing entries and return
        if( !valid_socks?.length ) {
            log.warn( `No valid socks to write, deleting all existing entries` )
            await pool.query( `DELETE FROM worker_socks5_configs` )
            return { success: true }
        }

        // Get existing usernames from database
        const existing_result = await pool.query( `SELECT username FROM worker_socks5_configs` )
        const existing_usernames = existing_result.rows.map( ( { username } ) => username )

        // Separate incoming socks into updates and inserts based on username presence
        const incoming_usernames = valid_socks.map( ( { username } ) => username )
        const socks_to_update = valid_socks.filter( ( { username } ) => existing_usernames.includes( username ) )
        const socks_to_insert = valid_socks.filter( ( { username } ) => !existing_usernames.includes( username ) )

        // Find usernames to delete (in db but not in incoming list)
        const usernames_to_delete = existing_usernames.filter( username => !incoming_usernames.includes( username ) )

        const now = Date.now()

        // Update existing entries - only update username and password
        if( socks_to_update.length ) {
            const update_query = format( `
                UPDATE worker_socks5_configs
                SET password = data.password, updated = data.updated::BIGINT
                FROM ( VALUES %L ) AS data( username, password, updated )
                WHERE worker_socks5_configs.username = data.username
            `, socks_to_update.map( sock => [ sock.username, sock.password, now ] ) )
            await pool.query( update_query )
            log.info( `Updated ${ socks_to_update.length } existing SOCKS5 configs` )
        }

        // Insert new entries
        if( socks_to_insert.length ) {
            const insert_query = format( `
                INSERT INTO worker_socks5_configs ( ip_address, port, username, password, available, updated, expires_at )
                VALUES %L
            `, socks_to_insert.map( sock => [ sock.ip_address, sock.port, sock.username, sock.password, sock.available, now, 0 ] ) )
            await pool.query( insert_query )
            log.info( `Inserted ${ socks_to_insert.length } new SOCKS5 configs` )
        }

        // Delete entries not in incoming list
        if( usernames_to_delete.length ) {
            const delete_query = format( `
                DELETE FROM worker_socks5_configs
                WHERE username IN ( %L )
            `, usernames_to_delete )
            await pool.query( delete_query )
            log.info( `Deleted ${ usernames_to_delete.length } SOCKS5 configs not in incoming list` )
        }

        log.info( `Successfully synced SOCKS5 configs: ${ socks_to_update.length } updated, ${ socks_to_insert.length } inserted, ${ usernames_to_delete.length } deleted` )
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
        const regen_results = await Promise.all( expired_socks.map( ( { username } ) => regenerate_dante_socks5_config( { username } ) ) )
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
            SET available = TRUE, expires_at = 0, password = data.password, updated = data.updated
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
 * @returns {Promise<{ success: boolean, available_socks_count?: number, error?: string }>}
 */
export async function count_available_socks() {

    try {

        // Get pool
        const pool = await get_pg_pool()

        // Query count of available socks
        const query = `
            SELECT COUNT(*) AS available_count
            FROM worker_socks5_configs
            WHERE available = TRUE
        `
        const result = await pool.query( query )
        const available_socks_count = Number( result.rows[0]?.available_count || 0 )

        return { success: true, available_socks_count }

    } catch ( e ) {
        console.error( `Error in count_available_socks:`, e )
        return { success: false, error: e.message }
    }

}

/**
 * Registers a SOCKS5 proxy lease by marking an available proxy as unavailable
 * @param {Object} params
 * @param {number} params.expires_at - Timestamp when the lease expires
 * @returns {Promise<{ success: boolean, sock?: Object, error?: string }>}
 */
export async function register_socks5_lease( { expires_at } ) {

    const working_key = `register_socks5_lease_working`

    try {

        // Get pool and password directory
        const pool = await get_pg_pool()
        const { PASSWORD_DIR='/passwords' } = process.env

        // Mitigate race conditions
        let working = cache( working_key )
        while( working ) {
            log.debug( `register_socks5_lease is already in progress, waiting...` )
            await wait( 1000 )
            working = cache( working_key )
            log.debug( `Working: ${ working }` )
        }
        log.debug( `Starting register_socks5_lease` )
        cache( working_key, true )

        // Find an available socks5 config
        let sock = null
        let attempts = 0
        const { available_socks_count: max_attempts } = await count_available_socks()
        while( attempts < max_attempts && !sock ) {

            // Attempt to find an available sock
            log.info( `[WHILE] Attempt ${ attempts + 1 } to find available SOCKS5 config` )
            const select_query = `
                SELECT *
                FROM worker_socks5_configs
                WHERE available = TRUE
                LIMIT 1
            `
            const result = await pool.query( select_query )
            const [ available_sock ] = result.rows || []

            // If no available socks were found, regenerate expired configs
            if( !available_sock ) {
                log.warn( `No available SOCKS5 configs found, attempting to clean up expired configs` )
                await cleanup_expired_dante_socks5_configs()
                attempts++
                continue
            }

            // Test that the sock works
            const sock_string = `socks5://${ available_sock.username }:${ available_sock.password }@${ available_sock.ip_address }:${ available_sock.port }`
            await dante_server_ready( { max_wait_ms: 10_000 } )
            const sock_works = await test_socks5_connection( { sock: sock_string } )

            // If it works, select it
            if( sock_works ) {
                log.info( `Selected SOCKS5 config ${ sock_string } works locally` )
                sock = available_sock
                continue
            }

            // Mark sock as unavailable and expired
            log.warn( `Selected SOCKS5 config ${ sock_string } failed the connection test` )
            const update_query = `
                        UPDATE worker_socks5_configs
                        SET available = FALSE, expires_at = $1, updated = $2
                        WHERE username = $3 AND password = $4
                    `
            await pool.query( update_query, [ Date.now(), Date.now(), available_sock.username, available_sock.password ] )
            log.info( `Marked SOCKS5 config ${ sock_string } as unavailable due to failed test` )

            // Check that the password file exists
            const pass_file = `${ PASSWORD_DIR }/${ available_sock.username }.password`
            const pass_file_exists = await stat( pass_file ).then( () => true ).catch( () => false )
            const pass_used_file_exists = await stat( `${ pass_file }.used` ).then( () => true ).catch( () => false )
            log.warn( `Password file exists: ${ pass_file_exists }, used file exists: ${ pass_used_file_exists }` )

            // A non-working socks indicates that there is a mismatch between out database and the dante container, reload the configs from disk to sync
            await load_socks5_from_disk()

            // Increment attempts
            attempts++

        }

        if( !sock ) throw new Error( `No available SOCKS5 configs found after ${ max_attempts } attempts` )


        // Mark the config as unavailable
        if( sock ) {
            const update_query = `
                UPDATE worker_socks5_configs
                SET available = FALSE, expires_at = $1, updated = $2
                WHERE username = $3 AND password = $4
            `
            await pool.query( update_query, [ expires_at, Date.now(), sock.username, sock.password ] )
            log.info( `Registered SOCKS5 lease for ${ sock.ip_address }:${ sock.port }, expires at ${ new Date( expires_at ).toISOString() }` )
        }

        // Mark the password as unavailable through touching /passwords/<username>.password.used
        // this lets the dante container handle user state across restarts
        if( sock ) await run( `touch ${ PASSWORD_DIR }/${ sock.username }.password.used` )

        return { success: true, sock }


    } catch ( e ) {
        log.error( `Error in register_socks5_lease:`, e )
        return { success: false, error: e.message }
    } finally {
        // Release working lock
        cache( working_key, false )
    }

}
