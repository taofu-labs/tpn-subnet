import { cache, log, wait } from "mentie"
import { exec } from "child_process"
import { run } from "../system/shell.js"
import { count_available_socks, register_socks5_lease, write_socks } from "../database/worker_socks5.js"
import { access, open } from "fs/promises"

/**
 * Checks if the Dante SOCKS5 server is reachable on its public IP and port.
 * @returns {Promise<boolean>} A promise that resolves to true if the server is reachable, false otherwise.
 */
async function check_if_dante_reachable() {

    try {

        // Run netcat command to check if we can ready the container on the public ip
        const { DANTE_PORT=1080, SERVER_PUBLIC_HOST } = process.env
        if( !SERVER_PUBLIC_HOST ) throw new Error( `SERVER_PUBLIC_HOST is not set in environment variables` )
        if( !DANTE_PORT ) throw new Error( `DANTE_PORT is not set in environment variables` )
        const command = `nc -vz -w 10 ${ SERVER_PUBLIC_HOST } ${ DANTE_PORT }`
        log.info( `Checking Dante reachability with command: ${ command }` )
        const { stdout, stderr } = await run( command )
        const outputs = `stdout: ${ stdout }, stderr: ${ stderr }`
        const reachable = outputs.includes( 'succeeded' )
        log.info( `Dante reachable: ${ reachable }, outputs: ${ outputs }` )
        return reachable

    } catch ( e ) {
        log.info( `Error checking Dante reachability: ${ e.message }` )
        return false
    }

}

/**
 * Waits until the Dante SOCKS5 server port is reachable or until the maximum wait time is exceeded.
 * @param {Object} params - The parameters for the function.
 * @param {number} [params.max_wait_ms=Infinity] - The maximum time in milliseconds to wait.
 * @returns {Promise<boolean>} A promise that resolves to true if the server becomes reachable within the wait period, or false otherwise.
 */
export async function dante_server_ready( { max_wait_ms=Infinity } = {} ) {

    // Time tracking
    const start_time = Date.now()
    let time_passed = 0
    log.info( `Checking if Dante SOCKS5 server is ready` )

    // Wait for port to be reachable
    let reachable = await check_if_dante_reachable()
    while( !reachable && time_passed < max_wait_ms ) {
        log.info( `Dante SOCKS5 server not reachable yet, waiting 5 seconds before retrying...` )
        await wait( 5000 )
        time_passed = Date.now() - start_time
        reachable = await check_if_dante_reachable()
    }

    return reachable

}

/**
 * Loads SOCKS5 authentication credentials from disk and writes them to the database.
 * Reads password files from the configured PASSWORD_DIR and creates sock objects for each.
 * @returns {Promise<Object>} A promise that resolves to an object with success status.
 * @returns {boolean} return.success - True if loading succeeded, false otherwise.
 * @returns {string} [return.error] - Error message if loading failed.
 */
export async function load_socks5_from_disk() {

    try {

        // Load the auth files from /passwords/*.password
        const { PASSWORD_DIR='/passwords', DANTE_PORT=1080, SERVER_PUBLIC_HOST } = process.env
        log.info( `Loading SOCKS5 auth files from directory: ${ PASSWORD_DIR }` )

        // Get auth files and used auth files
        let { stdout: auth_files='' } = await run( `ls -d1 ${ PASSWORD_DIR }/*.password` )
        let { stdout: used_auth_files='' } = await run( `ls -d1 ${ PASSWORD_DIR }/*.password.used || echo ""` )

        // Parse file lists
        auth_files = auth_files?.split( '\n'  )?.filter( f => !!`${ f }`.trim().length )
        used_auth_files = used_auth_files?.split( '\n' )?.filter( f => !!`${ f }`.trim().length )
        log.info( `Found ${ auth_files?.length } auth files, ${ used_auth_files?.length } used auth files` )

        // Create socks objects from auth files
        const socks = await Promise.all( auth_files.map( async auth_path => {

            // Get username from filename
            const filename = auth_path.split( '/' ).pop()
            const username = filename.replace( '.password', '' )

            // Check if already used
            const available = !used_auth_files.includes( auth_path )
            
            // Read password from file
            let { stdout: password } = await run( `cat ${ auth_path }` )
            password = `${ password }`.trim()
            if( !password?.length ) log.warn( `Password file ${ auth_path } is empty` )

            // Create sock object
            const sock = {
                ip_address: SERVER_PUBLIC_HOST,
                port: Number( DANTE_PORT ),
                username,
                password,
                available
            }

            return sock
            
        } ) )

        // Write sockt to database
        await write_socks( { socks } )
        cache( 'dante_config_initialised', true )
        log.info( `Loaded ${ socks.length } SOCKS5 configs from disk and saved to database` )

        return { success: true }


    } catch ( e ) {
        log.error( `Error in load_socks5_from_disk:`, e )
        return { success: false, error: e.message }
    }
}

/**
 * Restarts the Dante SOCKS5 container and invalidates the cached configuration.
 * @returns {Promise<void>} A promise that resolves when the container is restarted.
 */
export async function restart_dante_container() {

    // Restart the dante container, note that this relies on the container being named "dante"
    try {
        log.info( `Restarting dante container` )
        const result = await new Promise( ( resolve, reject ) => {
            exec( `docker restart dante`, ( error, stdout, stderr ) => {
                if( error ) return reject( error )
                if( stderr ) return reject( stderr )
                resolve( stdout )
            } )
        } )

        // Mark dante config as uninitialised so it reloads on next use
        cache( 'dante_config_initialised', false )
        
        log.info( `Restarted dante container`, result )
    } catch ( e ) {
        log.error( `Error in restart_dante_container:`, e )
    }
}

/**
 * Regenerates the password for a given Dante SOCKS5 username by signaling the Dante server.
 * @param {Object} params - The parameters for the function.
 * @param {string} params.username - The username for which to regenerate the password.
 * @returns {Promise<Object>} A promise that resolves to an object containing the username and new password.
 * @returns {string} return.username - The SOCKS5 username.
 * @returns {string} return.password - The newly regenerated SOCKS5 password.
 */
export async function regenerate_dante_socks5_config( { username } ) {

    try {

        // Build paths for the regen request and password files
        const { DANTE_REGEN_REQUEST_DIR='/dante_regen_requests' } = process.env
        const regen_file = `${ DANTE_REGEN_REQUEST_DIR }/${ username }`
        const { PASSWORD_DIR='/passwords' } = process.env
        const password_file = `${ PASSWORD_DIR }/${ username }.password`

        // Touch the regen_request file for the username to signal dante to regen the password
        await open( regen_file, 'w' ).then( f => f.close() )
        log.info( `Touched regen request file for username: ${ username }` )

        // Wait for file to be deleted by dante indicating regen is complete
        let regen_complete = false
        const max_wait_ms = 20_000
        const start_time = Date.now()
        while( !regen_complete ) {

            // Check for timeout
            const time_passed = Date.now() - start_time
            if( time_passed > max_wait_ms ) throw new Error( `Timeout waiting for Dante regen to complete for username ${ username }` )

            // Check if regen is complete by seeing if the regen request file has been deleted
            regen_complete = await access( regen_file ).then( () => false ).catch( () => true )
            await wait( 2_000 )

        }

        // Once regen is complete, get the password from the file content
        let { stdout: password } = await run( `cat ${ password_file }` )
        password = `${ password }`.trim()
        if( !password?.length ) throw new Error( `Regenerated password file for username ${ username } is empty` )
        
        log.info( `Dante regen complete for username: ${ username }` )
        return { username, password }
        
    } catch ( e ) {
        log.error( `Error regenerating Dante SOCKS5 config for username ${ username }:`, e )
    }

}

/**
 * Retrieves a valid SOCKS5 configuration by leasing an available credential.
 * @param {Object} params - The parameters for the function.
 * @param {number} params.lease_seconds - The lease duration in seconds.
 * @returns {Promise<Object>} A promise that resolves to a SOCKS5 configuration object.
 * @returns {string} return.username - The SOCKS5 username.
 * @returns {string} return.password - The SOCKS5 password.
 * @returns {string} return.ip_address - The server IP address.
 * @returns {number} return.port - The server port.
 * @returns {number} return.expires_at - The expiration timestamp of the lease.
 */
export async function get_valid_socks5_config( { lease_seconds } ) {

    // Check if dante server is ready
    const dante_ready = await dante_server_ready()
    log.info( `Dante server ready: ${ dante_ready }` )

    // If we haven't loaded configs since boot, load them now
    const dante_config_initialised = cache( 'dante_config_initialised' )
    if( !dante_config_initialised ) await load_socks5_from_disk()

    // Formulate config parameters
    const expires_at = Date.now() +  lease_seconds * 1000 
    let { available_socks_count } = await count_available_socks()
    log.info( `There are ${ available_socks_count } available socks for lease_seconds: ${ lease_seconds }` )

    // If no socks available, restart the container and reload configs
    if( !available_socks_count ) {
        log.info( `No available socks, restarting Dante container to refresh configs` )
        await restart_dante_container()
        await check_if_dante_reachable()
        await load_socks5_from_disk()
        const { available_socks_count: new_available_socks_count } = await count_available_socks()
        log.info( `After restarting Dante, there are ${ new_available_socks_count } available socks` )
        available_socks_count = new_available_socks_count
        if( !available_socks_count ) throw new Error( `No available socks after restarting Dante container` )
    }
    
    // Get lease
    const { success, error, sock } = await register_socks5_lease( { expires_at } )
    log.info( `Leased SOCKS5 config: ${ sock.username }@${ sock.ip_address }:${ sock.port }, expires at ${ new Date( expires_at ).toISOString() }` )
    if( !success ) throw new Error( `Error leasing SOCKS5 config: ${ error }` )

    // Return the sock config
    const socks5_config = {
        username: sock.username,
        password: sock.password,
        ip_address: sock.ip_address,
        port: sock.port
    }

    return { socks5_config, expires_at }

}