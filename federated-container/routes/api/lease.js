import { Router } from "express"
import { createHash, timingSafeEqual } from "crypto"
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
import { test_http_proxy_connection } from "../../modules/networking/http_proxy.js"
const { CI_MOCK_WORKER_RESPONSES } = process.env
const lease_types = [ `wireguard`, `socks5`, `http` ]

// Constant-time key comparison to prevent timing attacks (H6)
// SHA-256 normalizes lengths so timingSafeEqual always compares 32 bytes
const constant_time_includes = ( keys, candidate ) => {
    if( Array.isArray( candidate ) ) {
        const [ first_candidate ] = candidate
        candidate = first_candidate
    }
    if( typeof candidate !== 'string' || !candidate ) return false
    const hash = val => createHash( 'sha256' ).update( val ).digest()
    const candidate_hash = hash( candidate )
    return keys.some( key => {
        if( typeof key !== 'string' || !key ) return false
        return timingSafeEqual( hash( key ), candidate_hash )
    } )
}

const proxy_url_from_config = ( { config, type } ) => {

    try {

        if( !config ) return null
        if( typeof config === `string` ) return config
        if( typeof config !== `object` ) return null

        const { username, password, ip_address, port } = config
        if( !username || !password || !ip_address || !port ) return null

        const proxy_url = new URL( `${ type }://${ ip_address }:${ port }` )
        proxy_url.username = username
        proxy_url.password = password

        return proxy_url.href.replace( /\/$/, `` )

    } catch {
        return null
    }

}

const apply_result_type = ( { result_type, current_type } ) => {

    if( !result_type ) return current_type
    if( lease_types.includes( result_type ) ) return result_type

    throw new Error( `Invalid result type: ${ result_type }. Must be one of ${ lease_types.map( type => `'${ type }'` ).join( ', ' ) }` )

}

/**
 * Extracts the entry IP — the endpoint the caller will connect to — from a lease config.
 * Handles text and JSON representations of WireGuard, SOCKS5, and HTTP proxy configs.
 * @param {Object} params
 * @param {string|Object} params.config - The lease config (text form or parsed JSON)
 * @param {string} params.type - The lease type ('wireguard', 'socks5', or 'http')
 * @returns {string|null} The entry IP, or null if it could not be determined
 */
const extract_entry_ip = ( { config, type } ) => {

    try {

        if( !config ) return null

        // WireGuard: JSON has peer.Endpoint = "ip:port"; text has an "Endpoint = ip:port" line
        if( type === 'wireguard' ) {
            if( typeof config === 'object' ) return config.peer?.Endpoint?.split( ':' )[ 0 ] || null
            let [ , ip ] = `${ config }`.match( /Endpoint\s*=\s*([^:\s]+)/ ) || []
            ip = sanetise_ipv4( { ip, validate: true } )
            return ip
        }

        // Proxy transports: JSON has ip_address; text is socks5://... or http://...
        if( [ 'socks5', 'http' ].includes( type ) ) {
            if( typeof config === 'object' ) return config.ip_address || null
            const { hostname } = new URL( `${ config }` )
            let ip = hostname
            ip = sanetise_ipv4( { ip, validate: true } )
            return ip
        }

        return null

    } catch ( e ) {

        log.warn( `Failed to extract entry IP from config: ${ e.message }` )
        return null
        
    }

}

export const router = Router()

router.get( [ '/config/new', '/lease/new' ], async ( req, res ) => {

    const { format='json' } = req.query || {}

    // Shared ref for resolved worker metadata — populated inside handle_route, read after
    const resolved_meta = {}

    const handle_route = async () => {

        // Clear stale metadata from previous retry attempts
        delete resolved_meta.connection_type
        delete resolved_meta.country
        delete resolved_meta.lease_ref
        delete resolved_meta.lease_expires_at
        delete resolved_meta.lease_token
        delete resolved_meta.entry_ip
        delete resolved_meta.exit_ip

        // Mining pool access controls
        const { mode, worker_mode, miner_mode, validator_mode } = run_mode()
        const request_from_validator = await is_validator_request( req )
        log.insane( `Handling new lease request as ${ mode }` )
        if( miner_mode ) {
            if( !request_from_validator ) {
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
            if( valid_keys.length && ( !api_key || !constant_time_includes( valid_keys, api_key ) ) ) {
                log.warn( `Attempted access with invalid API key` )
                // log.info( `🤡 Not blocking access yet until dev portal is live` )
                throw new Error( `Invalid or missing API key` )
            }
            log.info( `Validator lease request accepted with valid API key` )

        }

        // Prepare validation props based on run mode
        const mandatory_props = [ 'lease_seconds' ]
        const optional_props = [ 'geo', 'whitelist', 'blacklist', 'priority', 'format', 'lease_minutes', 'type', 'connection_type', 'feedback_url', 'lease_token', 'extend_ref', 'extend_expires_at' ]

        // Get all relevant data
        log.insane( `Request query params:`, Object.keys( req.query ), Object.values( req.query ), req.query )
        allow_props( req.query, [ ...mandatory_props, ...optional_props ], true )
        let { lease_seconds, lease_minutes, format='json', geo='any', whitelist, blacklist, priority=false, type='wireguard', connection_type='any', feedback_url, lease_token, extend_ref, extend_expires_at } = req.query

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
        if( miner_mode && request_from_validator ) priority = 'true'

        // Sanetise and parse inputs for each prop set
        lease_seconds = lease_seconds && parseInt( lease_seconds, 10 )
        format = format && sanetise_string( format )
        type = type && sanetise_string( type )
        geo = geo && `${ sanetise_string( geo ) }`.toUpperCase()
        whitelist = whitelist && sanetise_string( whitelist ).split( ',' )
        blacklist = blacklist && sanetise_string( blacklist ).split( ',' )
        priority = priority === 'true'
        const config_meta = { lease_seconds, format, geo, whitelist, blacklist, priority, type, connection_type, feedback_url, lease_token, extend_ref, extend_expires_at }

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
        if( type?.length && !lease_types.includes( type ) ) throw new Error( `Invalid type: ${ type }. Must be one of ${ lease_types.map( t => `'${ t }'` ).join( ', ' ) }` )
        if( geo?.length && !geo_available ) throw new Error( `No workers found for geo: ${ geo }.` )
        if( whitelist?.length && whitelist.some( ip => !is_ipv4( ip ) ) ) throw new Error( `Invalid ip addresses in whitelist` )
        if( blacklist?.length && blacklist.some( ip => !is_ipv4( ip ) ) ) throw new Error( `Invalid ip addresses in blacklist` )
        if( connection_type?.length && ![ 'any', 'datacenter', 'residential' ].includes( connection_type ) ) throw new Error( `Invalid connection_type: ${ connection_type }. Must be one of 'any', 'datacenter', 'residential'` )
        if( lease_token && extend_ref ) throw new Error( `Ambiguous extension request: provide either lease_token or extend_ref, not both` )
        if( extend_ref && !extend_expires_at ) throw new Error( `extend_expires_at is required when extend_ref is provided` )

        // Get the requested transport config based on run mode
        log.debug( `Getting config as ${ mode } with params:`, config_meta )
        let result = null
        if( validator_mode ) result = await get_worker_config_as_validator( config_meta )
        if( miner_mode ) result = await get_worker_config_as_miner( config_meta )
        if( worker_mode ) result = await get_worker_config_as_worker( config_meta )

        // Unwrap lease result — mining pool and validator return { _lease_result, config, ... }
        // Worker now returns { config, lease_ref, lease_expires_at } directly
        let config = result
        if( result?._lease_result ) {
            const {
                type: result_type,
                connection_type: result_connection_type,
                country: result_country,
                lease_ref,
                lease_expires_at,
                lease_token: result_lease_token,
                exit_ip,
                config: result_config
            } = result
            type = apply_result_type( { result_type, current_type: type } )
            if( result_connection_type ) resolved_meta.connection_type = result_connection_type
            if( result_country ) resolved_meta.country = result_country
            if( lease_ref != null ) resolved_meta.lease_ref = lease_ref
            if( lease_expires_at != null ) resolved_meta.lease_expires_at = lease_expires_at
            if( result_lease_token ) resolved_meta.lease_token = result_lease_token
            if( exit_ip ) resolved_meta.exit_ip = exit_ip
            config = result_config
        } else if( result?.lease_ref !== undefined ) {
            // Worker-mode result: { config, lease_ref, lease_expires_at }
            const { type: result_type, lease_ref, lease_expires_at, config: result_config } = result
            type = apply_result_type( { result_type, current_type: type } )
            if( lease_ref != null ) resolved_meta.lease_ref = lease_ref
            if( lease_expires_at != null ) resolved_meta.lease_expires_at = lease_expires_at
            config = result_config
        }

        // Derive entry IP — the endpoint the caller connects to — from the returned config
        resolved_meta.entry_ip = extract_entry_ip( { config, type } )

        // Annotate wireguard text configs with the entry/exit IP pair at the bottom
        // so downstream consumers can see the routing topology at a glance.
        if( type === 'wireguard' && typeof config === 'string' ) {
            const entry_ip = resolved_meta.entry_ip || 'unknown'
            const exit_ip = resolved_meta.exit_ip || 'unknown'
            config = `${ config }\n# Entry ip: ${ entry_ip } (you will connect to this)\n# Exit ip: ${ exit_ip } (you will appear to come from here)\n`
        }

        // Enrich JSON responses with resolved metadata in the body
        if( config && typeof config === 'object' ) {
            if( resolved_meta.connection_type && !config.connection_type ) config.connection_type = resolved_meta.connection_type
            if( resolved_meta.country && !config.country ) config.country = resolved_meta.country
            if( resolved_meta.lease_token ) config.lease_token = resolved_meta.lease_token
        }

        // Validate config
        if( !config ) throw new Error( `${ mode } failed to get config for ${ geo }` )
        if( type == 'socks5' ) {
            const sock = proxy_url_from_config( { config, type } )
            const { valid } = await test_socks5_connection( { sock } )
            log.info( `Socks5 config validation result: ${ valid } for ${ config?.ip_address || 'socks5 endpoint' }` )
        }
        if( type == 'http' ) {
            const proxy = proxy_url_from_config( { config, type } )
            const { valid } = await test_http_proxy_connection( { proxy } )
            log.info( `HTTP proxy config validation result: ${ valid } for ${ config?.ip_address || 'http proxy endpoint' }` )
        }

        log.info( `Successfully obtained config as ${ mode } for geo ${ geo } with priority ${ priority }` )
        return config

    }

    try {
        const retryable_handler = await make_retryable( handle_route, { retry_times, cooldown_in_s } )
        const response_data = await retryable_handler()

        // Set resolved metadata headers for all response formats (text consumers can read these)
        if( resolved_meta.country ) res.set( 'X-Country', resolved_meta.country )
        if( resolved_meta.connection_type ) res.set( 'X-Connection-Type', resolved_meta.connection_type )
        if( resolved_meta.lease_ref ) res.set( 'X-Lease-Ref', `${ resolved_meta.lease_ref }` )
        if( resolved_meta.lease_expires_at ) res.set( 'X-Lease-Expires', `${ resolved_meta.lease_expires_at }` )
        if( resolved_meta.lease_token ) res.set( 'X-Lease-Extension-Token', resolved_meta.lease_token )
        if( resolved_meta.entry_ip ) res.set( 'X-Entry-Ip', resolved_meta.entry_ip )
        if( resolved_meta.exit_ip ) res.set( 'X-Exit-Ip', resolved_meta.exit_ip )

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
