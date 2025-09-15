import { is_ipv4, log, wait } from "mentie"
import { ip_from_req } from "./network.js"
import { get_tpn_cache } from "../caching.js"
const { CI_MODE, CI_VALIDATOR_IP_OVERRIDES } = process.env

// This hardcoded validator list is a failover for when the neuron did not submit the latest validator ips
export const validators_ip_fallback = [

    // Live validators as on https://taostats.io/subnets/65/metagraph?order=stake%3Adesc
    { uid: 117, ip: '34.130.136.222' },
    { uid: 4, ip: '88.204.136.220' },
    { uid: 0, ip: '88.204.136.221' },
    { uid: 47, ip: '161.35.91.172' },
    { uid: 212, ip: '192.150.253.122' },

]

// Manual override for ips that should be considered validators for the purpose of miner API requests
export const validators_ip_overrides = [ ...CI_VALIDATOR_IP_OVERRIDES ? CI_VALIDATOR_IP_OVERRIDES.split( ',' ) || [] : [], '88.204.136.221', '88.204.136.220', '161.35.91.172' ]

/**
 * Get the list of validator IPs
 * @param {Object} options - Options object
 * @param {boolean} options.ip_only - If true, return only the IP addresses.
 * @param {boolean} options.overrides_only - If true, return only the override IPs.
 * @param {boolean} options.skip_overrides - If true, skip adding override IPs to the list.
 * @returns {Promise<Object[]>} A promise that resolves to an array of validator objects with uid and ip.
 */
export const get_validators = async ( { ip_only=false, overrides_only=false, skip_overrides=false } ) => {

    // Get validators from cache
    let validators = overrides_only ? [] : get_tpn_cache( 'last_known_validators', [] )
    let attempts = 0

    // Give the protocol broadcast a moment to populate cache on cold starts
    while( CI_MODE !== 'true' && !validators?.length && attempts < 5 ) {
        log.info( `[ WHILE ] No validators found in cache, waiting 5 seconds and retrying...` )
        await wait( 5_000 )
        validators = get_tpn_cache( 'last_known_validators', [] )
        attempts++
    }


    // Add ip overrides to validators
    if( !skip_overrides ) validators = [ ...validators, ...validators_ip_overrides.map( ip => ( { ip, uid: ip.replaceAll( '.', '' ), override: true } ) ) ]
    log.info( `Found ${ validators.length } validators, ${ validators_ip_overrides.length } overrides` )


    // Return fallback validators if no validators found in cache
    if( !validators?.length ) {
        log.error( `No validators found in cache` )
        return validators_ip_fallback
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
 * Checks if request came from known validator ip
 * @param {Object} request - The request object
 * @returns {Promise<{ uid: number, ip: string }>} An object containing the validator's uid and ip address.
 * @description Checks if the request is from a validator by matching
 */
export async function is_validator_request( request ) {

    // In CI mode, bypass this check
    if( CI_MODE ) {
        log.info( `CI_MODE is enabled, bypassing validator check` )
        return { uid: 99999, ip: 'mock.mock.mock.mock' }
    }

    // Get the ip of the originating request
    const { unspoofable_ip, spoofable_ip } = ip_from_req( request )
    log.info( `Request ip: ${ unspoofable_ip } (spoofable: ${ spoofable_ip } )` )

    // Check if input is ipv4
    if( !is_ipv4( unspoofable_ip ) ) return false


    // Find first matching validator
    const validators = await get_validators()
    const validator = validators.find( val => val.ip == unspoofable_ip )
    if( validator ) return validator

    // If no validator found, return false
    return {}

}
