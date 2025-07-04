import { log, wait } from "mentie"
import { ip_from_req } from "./network.js"
import { get_tpn_cache } from "./caching.js"
const { CI_MODE } = process.env

// This hardcoded validator list is a failover for when the neuron did not submit the latest validator ips
const validators_fallback = [

    // Live validators as on https://taostats.io/subnets/65/metagraph?order=stake%3Adesc
    { uid: 117, ip: '34.130.136.222' },
    { uid: 4, ip: '185.141.218.102' },
    { uid: 47, ip: '161.35.91.172' },
    { uid: 212, ip: '192.150.253.122' },
    { uid: 0, ip: '185.189.44.166' },

    // Testnet validators
    { uid: null, ip: '165.232.93.107' },
    { uid: null, ip: '159.223.6.225' }

]

const get_validators = async () => {

    // Get validators from cache
    let validators = get_tpn_cache( 'last_known_validators' )
    let attempts = 0

    while( !validators?.length && attempts < 5 ) {
        log.info( `[ WHILE ] No validators found in cache, waiting 5 seconds and retrying...` )
        await wait( 5_000 )
        validators = get_tpn_cache( 'last_known_validators' )
        attempts++
    }

    // Return fallback validators if no validators found in cache
    if( !validators?.length ) {
        log.error( `No validators found in cache` )
        return validators_fallback
    }

    // For all validators to use, check that their ip is not 0.0.0.0, if it is override with hardcoded list above
    for( const validator of validators ) {
        if( validator.ip == '0.0.0.0' ) {
            log.warn( `Validator ${ validator.uid } has ip 0.0.0.0, using hardcoded list instead` )
            validator.ip = validators_fallback.find( val => val.uid == validator.uid )?.ip || '0.0.0.0'
        }
    }

    return validators

}

export async function validator_count() {

    // Remove testnet validators and return count
    const validators = await get_validators()
    return validators.filter( ( { uid } ) => !!uid ).length
    
}

export async function validator_ips() {
    
    // Remove testnet validators aand 0.0.0.0 entries
    const validators = await get_validators()
    const ips = validators.filter( ( { uid, ip } ) => uid !== null && ip != '0.0.0.0' ).map( ( { ip } ) => ip )
    return ips

}

export async function is_validator( request ) {

    // In CI mode, bypass this check
    if( CI_MODE ) {
        log.info( `CI_MODE is enabled, bypassing validator check` )
        return { uid: Infinity, ip: 'mock.mock.mock.mock' }
    }

    // Get the ip of the originating request
    const { unspoofable_ip, spoofable_ip } = ip_from_req( request )
    log.info( `Request ip: ${ unspoofable_ip } (spoofable: ${ spoofable_ip } )` )

    // Check if input is ipv4 (very naively)
    const is_ipv4 = unspoofable_ip.match( /\d*.\d*.\d*.\d*/ )
    if( !is_ipv4 ) return false


    // Find first matching validator
    const validators = await get_validators()
    const validator = validators.find( val => val.ip == unspoofable_ip )

    return validator

}
