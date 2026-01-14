import { exec } from 'child_process'
import { cache, log } from 'mentie'
import { run_mode } from '../validations.js'
import { readFile } from 'fs/promises'


/**
 * Executes a shell command asynchronously and logs the output based on the provided options. 
 * @param {Object} [options={}] - Options to control the execution and logging behavior.
 * @param {boolean} [options.silent=false] - If true, suppresses all logging.
 * @param {boolean} [options.verbose=false] - If true, logs detailed output including errors, stdout, and stderr.
 * @param {string} [options.log_tag=`[ ${Date.now()} ] `] - A custom log tag to prefix log messages.
 * @returns {Promise<Object>} A promise that resolves with an object containing:
 *   - `error` (Error|null): The error object if the command fails, or null if no error occurred.
 *   - `stdout` (string|null): The standard output of the command, or null if empty.
 *   - `stderr` (string|null): The standard error output of the command, or null if empty.
 */
export async function run( command, { silent=true, verbose=false, log_tag=`[ ${ Date.now() } ] ` }={} ) {

    // Setting verbose overrides silent
    if( verbose ) silent = false

    return new Promise( ( resolve ) => {


        if( !silent && !verbose ) log.info( log_tag, `exec:`, command )
        exec( command, ( error, stdout, stderr ) => {

            if( !stderr?.length ) stderr = null
            if( !stdout?.length ) stdout = null

            // If silent, just resolve with data
            if( silent ) return resolve( { error, stdout, stderr } )
            
            // If verbose, log all
            if( verbose ) log.info( log_tag, { command, error, stdout, stderr } )
            else log.debug( log_tag, { command, error, stdout, stderr } )

            // Log the output
            if( !verbose && stdout ) log.debug( log_tag, `stdout:`, stdout.trim?.() || stdout )
            if( !verbose && stderr ) log.debug( log_tag, `stderr:`, stderr.trim?.() || stderr )
            if( !verbose && error && !stderr ) log.debug( log_tag, `Error running ${ command }:`, error )


            // Resolve with data
            resolve( { error, stdout, stderr } )

        } )

    } )

}

/**
 * Checks the system for warnings related to available resources and configuration.
 * @returns {Promise<void>}
 */
export async function check_system_warnings() {

    try {

        // Check if we are running on mac, make sure we set up linux mocks
        const is_mac = process.platform === 'darwin'
        const precall_setup = is_mac ? `source ./scripts/mock-linux-on-mac.sh; ` : ``

        // Check system ram amount
        const { mode, worker_mode, validator_mode, miner_mode } = run_mode()
        const ram_reccs = { miner: 4, validator: 8, worker: 1 }
        const min_ram_gib = ram_reccs[ mode ] || 8
        const ram_check = await run( `${ precall_setup }free -g | grep Mem | awk '{print $2}'` )
        const ram_gib = ram_check.stdout && parseInt( ram_check.stdout.trim() )
        if( ram_gib < min_ram_gib ) log.warn( `Your system has only ${ ram_gib } GiB of RAM, which is below the recommended ${ min_ram_gib } GiB. This may cause performance issues.` )    

        // Check if the system has a swap
        const swap_check = await run( `${ precall_setup }cat /proc/swaps | wc -l` )
        const has_swap = swap_check.stdout && parseInt( swap_check.stdout.trim() ) > 1
        if( !has_swap ) log.warn( `Your system doesn't appear to have a swapfile configured, you should probably set that up to prevent crashes under load` )

        // Check if the system has enough disk space
        const disk_reccs = { miner: 10, validator: 10, worker: 5 }
        const min_disk_space_gib = disk_reccs[ mode ] || 10
        const disk_check = await run( `${ precall_setup }df -BG / | tail -1 | awk '{print $4}'` )
        const disk_space_gib = disk_check.stdout && parseInt( disk_check.stdout.trim().replace( 'G', '' ) )
        if( disk_space_gib < min_disk_space_gib ) log.warn( `Your system has only ${ disk_space_gib } GiB of free disk space, which is below the recommended ${ min_disk_space_gib } GiB. This may cause performance issues.` )

        // Check if the host user is root
        const is_root = process.getuid && process.getuid() === 0
        if( is_root ) log.warn( `You are running this ${ mode } as root, which is not recommended. Please run it as a non-root user to avoid potential security issues.` )

        // If the constinuent variables are set, but not the SERVER_PUBLIC_URL this is probably a raw nodejs run, we'll declare the env var
        const { SERVER_PUBLIC_URL, SERVER_PUBLIC_PROTOCOL, SERVER_PUBLIC_HOST, SERVER_PUBLIC_PORT } = process.env
        if( !SERVER_PUBLIC_URL ) process.env.SERVER_PUBLIC_URL = `${ SERVER_PUBLIC_PROTOCOL }://${ SERVER_PUBLIC_HOST }:${ SERVER_PUBLIC_PORT }`
        
        // Check if recommended environment variables are set
        const recommended_env_vars = [ 
            `LOG_LEVEL`,
            `POSTGRES_PASSWORD`,
            `SERVER_PUBLIC_PROTOCOL`,
            `SERVER_PUBLIC_HOST`,
            `SERVER_PUBLIC_PORT`,
            ... validator_mode || miner_mode  ? [
                `SERVER_PUBLIC_URL`, 
                `MAXMIND_LICENSE_KEY`, 
                `IP2LOCATION_DOWNLOAD_TOKEN`,
                `SWAG_DOMAIN_NAME`,
                `SWAG_EMAIL`,
                `ADMIN_API_KEY`
            ] : [],
            ...validator_mode ? [
                `VALIDATOR_LEASE_API_KEYS`
            ] : [],
            ...miner_mode ? [ 
                `MINING_POOL_WEBSITE_URL`,
                `MINING_POOL_REWARDS`
            ] : [],
            ...worker_mode ? [ 
                `PAYMENT_ADDRESS_EVM`, 
                `PAYMENT_ADDRESS_BITTENSOR`,
                `MINING_POOL`
            ] : [],
        ]
        const missing_keys = recommended_env_vars.filter( key => !process.env[ key ] )
        if( missing_keys.length ) log.warn( `The following recommended environment variables are not set: ${ missing_keys.join( ', ' ) }. This may cause issues with the validator. See README.md for instructions` )
        
    } catch ( e ) {
        log.error( `Error checking system warnings:`, e )
    }

}

/**
 * Get current Git branch and short commit hash.
 * @returns {Promise<{ branch: string, hash: string }>} An object containing the branch name and short commit hash.
 */
export async function get_git_branch_and_hash() {

    try {
        const cache_branch = cache( 'git_branch' )
        const cache_hash = cache( 'git_hash' )
        const cache_last_commit_date = cache( 'git_last_commit_date' )
        const branch = cache_branch || await new Promise( ( resolve, reject ) => {
            exec( 'git rev-parse --abbrev-ref HEAD', ( error, stdout ) => {
                if( error ) return reject( error )
                const branch_name = stdout.trim()
                cache( 'git_branch', branch_name )
                resolve( branch_name )
            } )
        } )
        const hash = cache_hash || await new Promise( ( resolve, reject ) => {
            exec( 'git rev-parse --short HEAD', ( error, stdout ) => {
                if( error ) return reject( error )
                const commit_hash = stdout.trim()
                cache( 'git_hash', commit_hash )
                resolve( commit_hash )
            } )
        } )
        const last_commit_date = cache_last_commit_date || await new Promise( ( resolve, reject ) => {
            exec( 'git log -1 --format=%cd --date=iso-strict', ( error, stdout ) => {
                if( error ) return reject( error )
                const commit_date = stdout.trim()
                cache( 'git_last_commit_date', commit_date )
                resolve( commit_date )
            } )
        } )
        return { branch, hash, last_commit_date }
    } catch ( e ) {
        log.error( `Failed to get git branch and hash: ${ e.message }` )
        return { branch: 'unknown', hash: 'unknown' }
    }
}

/**
 * Retrieves the current Node.js version and caches it for future use.
 * @returns {Promise<string>} The current Node.js version.
 */
export async function get_node_version() {

    // Check for cached value
    const cached_version = cache( 'node_version' )
    if( cached_version ) return cached_version

    // Read version from package.json
    const { version } = JSON.parse( await readFile( new URL( '../../package.json', import.meta.url ) ) )

    // Cache and return version
    cache( 'node_version', version )
    return version

}