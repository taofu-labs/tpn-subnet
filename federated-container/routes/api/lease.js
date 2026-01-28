import { Router } from "express"
import { allow_props, is_ipv4, log, make_retryable, sanetise_ipv4, sanetise_string } from "mentie"
import { cooldown_in_s, retry_times } from "../../modules/networking/routing.js"
import { run_mode } from "../../modules/validations.js"
import { get_worker_config_as_miner } from "../../modules/api/mining_pool.js"
import { get_worker_config_as_validator } from "../../modules/api/validator.js"
import { get_worker_config_as_worker } from "../../modules/api/worker.js"
import { is_validator_request } from "../../modules/networking/validators.js"
import { ip_from_req, resolve_domain_to_ip } from "../../modules/networking/network.js"
import { MINING_POOL_URL } from "../../modules/networking/worker.js"
import { country_name_from_code } from "../../modules/geolocation/helpers.js"
import { get_worker_countries_for_pool } from "../../modules/database/workers.js"
import { test_socks5_connection } from "../../modules/networking/socks5.js"
const { CI_MOCK_WORKER_RESPONSES } = process.env

export const router = Router()

router.get( [ '/config/new', '/lease/new' ], async ( req, res ) => {

    const { format='json' } = req.query || {}

    const handle_route = async () => {

        // Mining pool access controls
        const { mode, worker_mode, miner_mode, validator_mode } = run_mode()
        const request_from__validator = await is_validator_request( req )
        log.insane( `Handling new lease request as ${ mode }` )
        if( miner_mode ) {
            if( !request_from__validator ) {
                const { unspoofable_ip } = ip_from_req( req )
                log.debug( `Denied lease request to miner from non-validator IP: ${ unspoofable_ip }` )
                throw new Error( `Miners only accept lease requests from validators, which you (${ unspoofable_ip }) are not` )
            }
        }

        // Worker access controls
        if( worker_mode && !CI_MOCK_WORKER_RESPONSES ) {
            log.info( `Checking if caller is mining pool: ${ MINING_POOL_URL }` )
            const { hostname } = new URL( MINING_POOL_URL )
            let { unspoofable_ip } = ip_from_req( req )
            const { ip: mining_pool_ip } = await resolve_domain_to_ip( { domain: hostname } )
            const ip_match = sanetise_ipv4( { ip: unspoofable_ip } ) === sanetise_ipv4( { ip: mining_pool_ip } )
            log.debug( `Worker lease request from ${ unspoofable_ip }, mining pool resolved ip is ${ mining_pool_ip }, match: ${ ip_match }` )
            if( !ip_match ) {
                log.warn( `Attempted access denied for ${ mining_pool_ip } because it does not match caller IP ${ unspoofable_ip }` )
                throw new Error( `Worker does not accept lease requests from ${ unspoofable_ip }` )
            }
        }

        // Validator access controls
        if( validator_mode ) {

            // Get api key in x-api-key
            const api_key = req.headers['x-api-key'] || null
            const valid_keys = `${ process.env.VALIDATOR_LEASE_API_KEYS || '' }`.split( ',' ).map( key => key.trim() ).filter( key => key.length )
            if( !valid_keys.length ) {
                log.info( `Validator has no api key set in VALIDATOR_LEASE_API_KEYS, denying lease requests by default` )
                // log.info( `🤡 Not blocking access yet until dev portal is live` )
                throw new Error( `This validator does not serve leases publicly due to it's configuration` )
            }
            if( valid_keys.length && ( !api_key || !valid_keys.includes( api_key ) ) ) {
                log.warn( `Attempted access with invalid API key: ${ api_key }` )
                // log.info( `🤡 Not blocking access yet until dev portal is live` )
                throw new Error( `Invalid or missing API key` )
            }
            log.info( `Validator lease request accepted with valid API key` )

        }

        // Prepare validation props based on run mode
        const mandatory_props = [ 'lease_seconds' ]
        const optional_props = [ 'geo', 'whitelist', 'blacklist', 'priority', 'format', 'lease_minutes', 'type', 'connection_type', 'feedback_url' ]

        // Get all relevant data
        log.insane( `Request query params:`, Object.keys( req.query ), Object.values( req.query ), req.query )
        allow_props( req.query, [ ...mandatory_props, ...optional_props ], true )
        let { lease_seconds, lease_minutes, format='json', geo='any', whitelist, blacklist, priority=false, type='wireguard', connection_type='any', feedback_url } = req.query

        // Backwards compatibility
        if( !`${ lease_seconds }`.length && `${ lease_minutes }`.length ) {
            const _lease_seconds = Number( lease_minutes ) * 60
            lease_seconds = _lease_seconds
            log.info( `Deprecation warning: lease_minutes is deprecated, use lease_seconds instead, converting ${ lease_minutes } minutes to ${ _lease_seconds } seconds` )
        }

        // Priority logic:
        // requests to validators are always overridden to false (is world)
        // requests from validators to mining pools are always overridden to true (weights relevant)
        // requests from mining pools to workers respect the requested value
        if( validator_mode ) priority = 'false'
        if( miner_mode && request_from__validator ) priority = 'true'

        // Sanetise and parse inputs for each prop set
        lease_seconds = lease_seconds && parseInt( lease_seconds, 10 )
        format = format && sanetise_string( format )
        type = type && sanetise_string( type )
        geo = geo && `${ sanetise_string( geo ) }`.toUpperCase()
        whitelist = whitelist && sanetise_string( whitelist ).split( ',' )
        blacklist = blacklist && sanetise_string( blacklist ).split( ',' )
        priority = priority === 'true'
        const config_meta = { lease_seconds, format, geo, whitelist, blacklist, priority, type, connection_type, feedback_url }

        // Geo availability check in non-worker mode, workers do not need geo check as they are static and only called with 'any'
        let geo_available = true
        if( !worker_mode ) {
            const available_countries = await get_worker_countries_for_pool()
            geo_available = [ ...available_countries, 'ANY' ].includes( geo )
            if( !geo_available ) log.debug( `No workers found for geo: ${ geo } in `, available_countries )
        }

        // Validate inputs as specified in props
        if( !lease_seconds || isNaN( lease_seconds ) ) throw new Error( `Invalid lease_seconds: ${ lease_seconds }. Must be a valid number greater than 0.` )
        if( format?.length && ![ 'json', 'text' ].includes( format ) ) throw new Error( `Invalid format: ${ format }. Must be one of 'json', 'text'` )
        if( type?.length && ![ 'wireguard', 'socks5' ].includes( type ) ) throw new Error( `Invalid type: ${ type }. Must be one of 'wireguard', 'socks5'` )
        if( geo?.length && !geo_available ) throw new Error( `No workers found for geo: ${ geo }.` )
        if( whitelist?.length && whitelist.some( ip => !is_ipv4( ip ) ) ) throw new Error( `Invalid ip addresses in whitelist` )
        if( blacklist?.length && blacklist.some( ip => !is_ipv4( ip ) ) ) throw new Error( `Invalid ip addresses in blacklist` )
        if( connection_type?.length && ![ 'any', 'datacenter', 'residential' ].includes( connection_type ) ) throw new Error( `Invalid connection_type: ${ connection_type }. Must be one of 'any', 'datacenter', 'residential'` )

        // Get relevant wireguard config based on run mode
        log.debug( `Getting config as ${ mode } with params:`, config_meta )
        let config = null
        if( validator_mode ) config = await get_worker_config_as_validator( config_meta )
        if( miner_mode ) config = await get_worker_config_as_miner( config_meta )
        if( worker_mode ) config = await get_worker_config_as_worker( config_meta )

        // Validate config
        if( !config ) throw new Error( `${ mode } failed to get config for ${ geo }` )
        if( type == 'socks5' ) {
            const sock = format == 'text' ? config : `socks5://${ config.username }:${ config.password }@${ config.ip_address }:${ config.port }`
            const valid = await test_socks5_connection( { sock } )
            log.info( `Socks5 config validation result: ${ valid } for config: ${ sock }` )
        }

        return config

    }

    try {
        const retryable_handler = await make_retryable( handle_route, { retry_times, cooldown_in_s } )
        const response_data = await retryable_handler()
        return format == 'text' ? res.send( response_data ) : res.json( response_data )
    } catch ( e ) {
        log.info( `Error handling new lease route: ${ e.message }` )
        return res.status( 500 ).json( { error: `Error handling new lease route: ${ e.message }` } )
    }
} )


router.get( [ '/config/countries', '/lease/countries' ], async ( req, res ) => {

    const { format='json', type='code', connection_type='any' } = req.query || {}

    const handle_route = async () => {

        // Validate inputs
        if( ![ 'json', 'text' ].includes( format ) ) throw new Error( `Invalid format: ${ format }` )
        if( ![ 'code', 'name' ].includes( type ) ) throw new Error( `Invalid type: ${ type }` )
        if( ![ 'any', 'datacenter', 'residential' ].includes( connection_type ) ) throw new Error( `Invalid connection_type: ${ connection_type }` )

        const country_codes = await get_worker_countries_for_pool( { connection_type } )
        const country_names = country_codes.map( country_name_from_code )

        if( format == 'json' && type == 'code' ) return country_codes
        if( format == 'json' && type == 'name' ) return country_names
        if( format == 'text' && type == 'code' ) return country_codes.join( '\n' )
        if( format == 'text' && type == 'name' ) return country_names.join( '\n' )

    }

    try {
        const retryable_handler = await make_retryable( handle_route, { retry_times, cooldown_in_s } )
        const response_data = await retryable_handler()
        if( format == 'text' ) return res.send( response_data )
        return res.json( response_data )
    } catch ( error ) {
        return res.status( 500 ).json( { error: `Error handling stats route: ${ error.message }` } )
    }
} )