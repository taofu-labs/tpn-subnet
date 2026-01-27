import { cache, log, wait } from "mentie"
import { format, get_pg_pool } from "./postgres.js"
import { run } from "../system/shell.js"
import { test_socks5_connection } from "../networking/socks5.js"
import { stat } from "fs/promises"
import { regenerate_dante_socks5_config } from "../networking/dante-container.js"

/**
 * Writes SOCKS5 proxy configurations to the database
 * @param {Object} params
 * @param {Array<{ ip_address: string, port: number, username: string, password: string, available: boolean }>} params.socks - Array of SOCKS5 configurations
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export async function write_socks( { socks } ) {

    try {

        // Get pool
        const pool = await get_pg_pool()

        // Validate socks
        const expected_properties = [ 'ip_address', 'port', 'username', 'password', 'available' ]
        let valid_socks = socks.filter( sock => {
            const sock_props = Object.keys( sock )
            return expected_properties.every( prop => sock_props.includes( prop ) )
        } )

        log.info( `Received  ${ socks.length  } socks, ${ valid_socks.length } valid socks, excerpt: `, socks.slice( 0, 1 ) )

        // Annotate with timestamp
        const now = Date.now()
        valid_socks = valid_socks.map( sock => ( { ...sock, updated: now } ) )

        // If no valid socks, return
        if( !valid_socks?.length ) {
            log.warn( `No valid socks to write` )
            return { success: false, error: `No valid socks to write` }
        }

        // Prepare a query that deletes existing entries for the given IPs
        const ips = valid_socks.map( sock => sock.ip_address )
        const delete_query = format( `
            DELETE FROM worker_socks5_configs
            WHERE ip_address IN ( %L )
        `, ips )

        // Prepare the addition query
        const insert_query = format( `
            INSERT INTO worker_socks5_configs ( ip_address, port, username, password, available, updated, expires_at )
            VALUES %L
        `, valid_socks.map( sock => [ sock.ip_address, sock.port, sock.username, sock.password, sock.available, sock.updated, 0 ] ) )

        // Execute the delete
        log.info( `Deleting existing SOCKS5 configs for ${ ips.length } ips` )
        await pool.query( delete_query )

        // Execute the insert
        log.info( `Inserting ${ valid_socks.length } new SOCKS5 configs` )
        await pool.query( insert_query )

        log.info( `Successfully wrote SOCKS5 configs` )
        return { success: true }

    } catch ( e ) {
        log.error( `Error in write_available_socks:`, e )
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
        const max_attempts = 5
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
