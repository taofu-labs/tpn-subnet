import { cache, log, wait } from "mentie"
import { format, get_pg_pool } from "./postgres.js"
import { run } from "../system/shell.js"
import { test_socks5_connection } from "../networking/socks5.js"
import { stat } from "fs/promises"

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

        // Get pool
        const pool = await get_pg_pool()

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
            log.info( `[WHILE] Attempt ${ attempts + 1 } to find available SOCKS5 config` )
            const select_query = `
                SELECT *
                FROM worker_socks5_configs
                WHERE available = TRUE
                LIMIT 1
            `
            const result = await pool.query( select_query )
            const [ available_sock ] = result.rows || []
            if( available_sock ) sock = available_sock
            else await wait( 1000 )
            attempts++

        }

        if( !sock ) throw new Error( `No available SOCKS5 configs found after ${ max_attempts } attempts` )

        // Test that the sock works
        const sock_string = `socks5://${ sock.username }:${ sock.password }@${ sock.ip_address }:${ sock.port }`
        const sock_works = await test_socks5_connection( { sock: sock_string } )
        if( sock_works ) log.info( `Selected SOCKS5 config ${ sock.username }@${ sock.ip_address }:${ sock.port } works locally` )
        if( !sock_works ) {
            log.warn( `Selected SOCKS5 config ${ sock.username }@${ sock.ip_address }:${ sock.port } does not work` )

            // Check that the password file exists
            const { PASSWORD_DIR='/passwords' } = process.env
            // Use fs.stat to check if file exists
            const exists = stat( `${ PASSWORD_DIR }/${ sock.username }.password` )
            if( !exists ) {
                log.warn( `Password file for SOCKS5 user ${ sock.username } does not exist, cannot register lease. THIS SHOULD NEVER HAPPEN.` )
            } else {
                log.info( `Password file for SOCKS5 user ${ sock.username } exists.` )
            }

        }

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
        const { PASSWORD_DIR='/passwords' } = process.env
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
