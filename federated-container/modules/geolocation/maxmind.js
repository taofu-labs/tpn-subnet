import { log } from "mentie"
import { spawn } from 'child_process'
import { get_timestamp, set_timestamp } from "../database/timestamps.js"
import { geolocation_update_interval_ms } from "./helpers.js"
const { dirname } = import.meta
const { MAXMIND_LICENSE_KEY, CI_MODE } = process.env

/**
 * Initiates the Maxmind database update process.
 * @param {Object} [params] - Update parameters.
 * @param {Function} [params.on_err] - Callback for error events.
 * @param {Function} [params.on_close] - Callback for process close event.
 * @returns {ChildProcess|void} - The spawned child process or void in CI mode.
 */
function start_maxmind_update( { on_err, on_close }={} ) {

    // Check for license key
    if( !MAXMIND_LICENSE_KEY ) throw new Error( 'MAXMIND_LICENSE_KEY is required' )

    // In CI mode do not update Maxmind
    if( CI_MODE ) return log.info( `🤡 Skipping Maxmind update in CI mode` )

    const updateProcess = spawn( 'npm', [ 'run-script', 'updatedb', `license_key=${ MAXMIND_LICENSE_KEY }` ], {
        cwd: `${ dirname }/../../node_modules/geoip-lite`, // run in the geoip-lite directory
        shell: true // use shell for command
    } )
        
    // Listen for output from stdout
    updateProcess.stdout.on( 'data', ( data ) => {
        log.info( `Maxmind update progress:`, data.toString() )
    } )

    // Listen for errors on stderr
    if( on_err ) updateProcess.stderr.on( 'data', on_err )
        
    // Fires when the process exits
    if( on_close ) updateProcess.on( 'close', on_close )

    return updateProcess

}

/**
 * Updates the MaxMind GeoIP database by running the `updatedb` npm script.
 * @returns {Promise<string>} A promise that resolves with a success message when the update is complete, or rejects with an error message if the update fails.
 */
export async function update_maxmind() {

    // Check for license key
    if( !MAXMIND_LICENSE_KEY ) log.error( `MAXMIND_LICENSE_KEY is not set, Maxmind database will not be updated this WILL REDUCE YOUR EMISSIONS` )

    // Load geoip-lite
    const { default: geoip } = await import( 'geoip-lite' )

    // Check if there is a functioning maxmind database
    let maxmind_db_ok = false
    try {
        geoip.lookup( '1.1.1.1' )
        maxmind_db_ok = true
    } catch ( e ) {
        log.info( `Maxmind database is not functioning yet: `, e )
    }

    // Check if we should skip update based on timestamp, this is due to restarts possibly retriggering updates
    const update_min_interval_ms = geolocation_update_interval_ms / 2
    const last_update = await get_timestamp( { label: 'last_maxmind_update' } )
    const now = Date.now()
    const time_since_last_update = now - last_update
    if( time_since_last_update < update_min_interval_ms ) {
        log.info( `Maxmind database update age is below minimum interval of ${ update_min_interval_ms / 1000 / 60 } minutes` )
        return 'Maxmind database is up to date'
    }
    log.info( `Database age is ${ ( now - last_update ) / 1000 / 60 } minutes` )

    // If maxmind is ok, update in the background
    if( maxmind_db_ok ) {
        log.info( `✅ Maxmind database is functioning, updating in the background` )
        void start_maxmind_update( {
            on_err: ( data ) => {
                log.error( `Maxmind update error:`, data.toString() )
            },
            on_close: ( code ) => {
                log.info( `Maxmind update complete:`, code )
                log.info( `Reloading Maxmind database into memory` )
                geoip.reloadDataSync()
                log.info( `Maxmind database reloaded into memory` )
                set_timestamp( { label: 'last_maxmind_update', timestamp: Date.now() } ).then( () => {
                    log.info( `Maxmind database update timestamp set` )
                } )
            }
        } )
    }

    // If maxmind is not ok, we need to wait for the update to complete
    if( !maxmind_db_ok ) return new Promise( ( resolve, reject ) => {

        log.info( `🛑 Maxmind database is not yet functioning, updating in a blocking way now` )

        start_maxmind_update( {

            on_err: ( data ) => {
                log.error( `Maxmind update error:`, data.toString() )
                reject( data.toString() )
            },
            on_close: ( code ) => {
                log.info( `Maxmind update complete:`, code )

                // Reload database
                log.info( `Reloading Maxmind database into memory` )
                geoip.reloadDataSync()
                log.info( `Maxmind database reloaded into memory` )
                set_timestamp( { label: 'last_maxmind_update', timestamp: Date.now() } ).then( () => {
                    log.info( `Maxmind database update timestamp set` )
                    resolve( `Maxmind database update complete` )
                } )
            }
        } )

    } )

}