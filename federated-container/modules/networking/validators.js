import { is_ipv4, log, wait } from "mentie"
import { ip_from_req } from "./network.js"
import { get_tpn_cache } from "../caching.js"
const { CI_MODE, CI_VALIDATOR_IP_OVERRIDES } = process.env

// This hardcoded validator list is a failover for when the neuron did not submit the latest validator ips
export const validators_ip_fallback = [

    // Live validators as on https://taostats.io/subnets/65/metagraph?order=stake%3Adesc
    { uid: 0, ip: '167.150.153.165' },
    { uid: 4, ip: '167.150.153.65' },
    { uid: 47, ip: '161.35.91.172' },
    { uid: 117, ip: '136.116.243.78' },
    { uid: 121, ip: '46.62.166.187' },
    { uid: 181, ip: '192.150.253.122' },
    
]

// Manual override for ips that should be considered validators for the purpose of miner API requests
export const validators_ip_overrides = [ ...CI_VALIDATOR_IP_OVERRIDES ? CI_VALIDATOR_IP_OVERRIDES.split( ',' ) || [] : [] ]

/**
 * Get the list of validator IPs
 * @param {Object} options - Options object
 * @param {boolean} options.ip_only - If true, return only the IP addresses.
 * @param {boolean} options.overrides_only - If true, return only the override IPs.
 * @param {boolean} options.skip_overrides - If true, skip adding override IPs to the list.
 * @returns {Promise<Object[]>} A promise that resolves to an array of validator objects with uid and ip.
 */
export const get_validators = async ( { ip_only=false, overrides_only=false, skip_overrides=false }={} ) => {

    // Get validators from cache
    let validators = overrides_only ? [] : get_tpn_cache( 'last_known_validators', [] )
    let attempts = 0

    // Give the protocol broadcast a moment to populate cache on cold starts
    while( CI_MODE !== 'true' && !validators?.length && attempts < 5 ) {
        log.info( `[ WHILE ] No validators found in cache, waiting 20 seconds and retrying...` )
        await wait( 20_000 )
        validators = get_tpn_cache( 'last_known_validators', [] )
        attempts++
    }


    // Add ip overrides to validators
    if( !skip_overrides ) validators = [ ...validators, ...validators_ip_overrides.map( ip => ( { ip, uid: ip.replaceAll( '.', '' ), override: true } ) ) ]
    log.info( `Found ${ validators.length } validators, ${ validators_ip_overrides.length } overrides` )


    // Return fallback validators if no validators found in cache
    if( !validators?.length ) {
        log.error( `No validators found in cache, are you very sure the neuron is running?` )
        validators = [ ...validators_ip_fallback ]
    }

    // For all validators to use, check that their ip is not 0.0.0.0, if it is override with hardcoded list above
    for( const validator of validators ) {
        if( validator.ip == '0.0.0.0' ) {
            log.warn( `Validator ${ validator.uid } has ip 0.0.0.0, using hardcoded list instead` )
            validator.ip = validators_ip_fallback.find( val => val.uid == validator.uid )?.ip || '0.0.0.0'
        }
    }

    // If ip_only, map
    if( ip_only ) validators = validators.map( val => val.ip )

    return validators

}

/**
 * Checks if an HTTP request originates from a known validator.
 * @param {Object} request - The HTTP request object.
 * @returns {Promise<{uid: number, ip: string}|false>} - Validator identity or false if not a validator.
 */
export async function is_validator_request( request ) {

    // Get the ip of the originating request
    const { unspoofable_ip, spoofable_ip } = ip_from_req( request )
    log.debug( `Request ip: ${ unspoofable_ip } (spoofable: ${ spoofable_ip } )` )

    // Check if input is ipv4
    if( !is_ipv4( unspoofable_ip ) ) {
        log.info( `Request IP is not a valid IPv4 address` )
        return {}
    }


    // Find first matching validator
    const validators = await get_validators()
    const validator = validators.find( val => val.ip == unspoofable_ip )
    if( validator ) return validator


    // In CI mode, bypass this check
    if( CI_MODE ) {
        log.info( `CI_MODE is enabled, bypassing validator check` )
        return { uid: 99999, ip: 'mock.mock.mock.mock' }
    }


    // If no validator found, return false
    return false

}
