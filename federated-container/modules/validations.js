import { is_ipv4, log, require_props, sanetise_string } from "mentie"
import { country_name_from_code } from "./geolocation/helpers.js"

const { CI_MODE, SERVER_PUBLIC_PORT=3000 } = process.env
export const default_mining_pool='https://pool.taofu.xyz'

/**
 * Validates if a worker object has the required properties and a valid IPv4 address.
 * @param {Object} worker - The worker object to validate.
 * @returns {boolean} - Returns true if the worker is valid, otherwise false.
 */
export const is_valid_worker = ( worker ) => {

    try {

        if( !worker || typeof worker !== 'object' ) return false
        const { ip, country_code } = worker

        const has_required_props = require_props( worker, [ 'ip', 'country_code', 'public_port', 'mining_pool_url' ], false )
        if( !has_required_props ) {
            log.info( `Worker object is missing required properties:`, worker )
            return false
        }
    
        const valid_ip = is_ipv4( ip )
        if( !valid_ip ) {
            log.info( `Worker IP is not a valid IPv4 address: ${ ip }` )
            return false
        }

        // Check if country code is valid
        let valid_country = country_name_from_code( country_code )
        if( CI_MODE === 'true' && typeof country_code === 'string' && country_code.length > 0 ) valid_country = true
        if( !valid_country ) {
            log.info( `Worker country code is not valid: ${ country_code }` )
            return false
        }

        return true

    } catch {
        return false
    }

}

/**
 * Annotates a worker object with default values for missing properties.
 * @param {Object} worker - The worker object to annotate.
 * @returns {Object} - The worker object with defaults applied.
 */
export const annotate_worker_with_defaults = worker => {

    if( !worker || typeof worker !== 'object' ) return worker

    // Warnings
    if( !worker.public_port ) log.insane( `Worker is missing public_port:`, worker )

    let { public_port=SERVER_PUBLIC_PORT, ip, mining_pool_url=default_mining_pool, status='unknown' } = worker

    return {
        ...worker,
        ip,
        public_port,
        mining_pool_url,
        status
    }

}

/**
 * Sanitizes and normalizes worker object properties.
 * @param {Object} worker - The worker object to sanitize.
 * @returns {Object} - The sanitized worker object.
 */
export const sanetise_worker = worker => {

    // If not object, return
    if( !worker || typeof worker !== 'object' ) return {}

    // Sanetise ip property
    if( worker?.ip ) worker.ip = sanetise_string( worker.ip )

    // Sanetise country_code property
    if( worker?.country_code ) worker.country_code = sanetise_string( worker.country_code ).toUpperCase()

    // If mining pool url is a multiline string, take the longest line
    if( worker?.mining_pool_url && worker.mining_pool_url.includes( '\n' ) ) {
        const lines = worker.mining_pool_url.split( '\n' ).map( line => sanetise_string( line ) )
        worker.mining_pool_url = lines.find( line => line.length == Math.max( ...lines.map( l => l.length ) ) )
    }

    // Sanetise mining_pool_url property
    if( worker?.mining_pool_url ) worker.mining_pool_url = sanetise_string( worker.mining_pool_url )
    if( worker?.mining_pool_url && worker.mining_pool_url.endsWith( '/' ) ) worker.mining_pool_url = worker.mining_pool_url.replace( /\/+$/g, '' )

    // Sanetise public_port property
    if( worker?.public_port ) {
        let port = Number( worker.public_port )
        if( isNaN( port ) || port < 1 || port > 65535 ) port = SERVER_PUBLIC_PORT
        worker.public_port = port
    }

    return worker

}

/**
 * Gets the current run mode and its associated flags.
 * @returns {{ mode: string, worker_mode: boolean, miner_mode: boolean, validator_mode: boolean }} - An object containing the run mode and its flags.
 */
export const run_mode = () => {
    const { RUN_MODE } = process.env
    const mode = sanetise_string( RUN_MODE )
    if( ![ 'validator', 'miner', 'worker' ].includes( mode ) ) throw new Error( `Invalid run mode: ${ RUN_MODE }` )
    return {
        mode,
        worker_mode: mode == 'worker',
        miner_mode: mode == 'miner',
        validator_mode: mode == 'validator',
    }
}