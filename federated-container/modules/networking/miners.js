import { abort_controller, is_ipv4, log, wait } from "mentie"
import { ip_from_req } from "./network.js"
import { get_tpn_cache } from "../caching.js"
import { read_mining_pool_metadata } from "../database/mining_pools.js"

const { CI_MODE, CI_MINER_IP_OVERRIDES } = process.env

// Manual override IPs to always treat as miner (mining pool) origins
export const miners_ip_overrides = CI_MINER_IP_OVERRIDES ? CI_MINER_IP_OVERRIDES.split( ',' ) || [] : []

/**
 * Returns a list of miners as { uid, ip } from the in-memory cache.
 * Waits briefly (with retries) if the cache hasn't been populated yet by the neuron broadcast.
 */
export const get_miners = async ( { ip_only=false, overrides_only=false, skip_overrides=false }={} ) => {

    // Build miner list from cache mapping of uid -> ip
    let miners = overrides_only ? [] : get_tpn_cache( 'last_known_miners', [] )
    let attempts = 0

    // Give the protocol broadcast a moment to populate cache on cold starts
    while( CI_MODE !== 'true' &&  !miners?.length && attempts < 5 ) {
        log.info( `[ WHILE ] No miners found in cache, waiting 5 seconds and retrying...` )
        await wait( 5_000 )
        miners = get_tpn_cache( 'last_known_miners', [] )
        attempts++
    }

    // Add ip overrides to validators
    if( !skip_overrides ) miners = [ ...miners, ...miners_ip_overrides.map( ip => ( { uid: ip.replaceAll( '.', '' ), ip, override: true } ) ) ]

    // Filter out miners with an ip of 0.0.0.0
    miners = miners.filter( m => m.ip !== '0.0.0.0' )

    // If ip only, map
    if( ip_only ) miners = miners.map( m => m.ip )

    return miners
}

/**
 * Checks if request came from a known miner (mining pool) IP.
 * @param {Object} request - Express request object
 * @returns {Promise<{ uid: number, ip: string } | {}>} Matched miner identity or empty object.
 */
export async function is_miner_request( request ) {

    // Extract the remote IP
    const { unspoofable_ip, spoofable_ip } = ip_from_req( request )
    log.info( `Request ip: ${ unspoofable_ip } (spoofable: ${ spoofable_ip } )` )

    if( !is_ipv4( unspoofable_ip ) ) {
        log.info( `Request IP is not a valid IPv4 address` )
        return {}
    }

    // Match against known miners from cache
    const miners = await get_miners()
    const miner = miners.find( m => m.ip === unspoofable_ip )
    if( miner ) return miner


    // In CI mode, bypass this check
    if( CI_MODE ) {
        log.info( `CI_MODE is enabled, bypassing miner check` )
        return { uid: 99999, ip: 'mock.mock.mock.mock' }
    }

    // No match
    return {}
}

/**
 * Resolves a miner by UID using cached data.
 * @param {number|string} uid - The miner's unique identifier.
 * @returns {{uid: number, ip: string}|{}} - Miner object or empty object if not found.
 */
export function get_miner_by_uid( uid ) {
    const uid_to_ip = get_tpn_cache( 'miner_uid_to_ip', {} )
    const ip = uid_to_ip?.[ uid ]
    return ip ? { uid: Number( uid ), ip } : {}
}

/**
 * Resolves a miner by IP address using cached data.
 * @param {string} ip - The miner's IP address.
 * @returns {{uid: number, ip: string}|{}} - Miner object or empty object if not found.
 */
export function get_miner_by_ip( ip ) {
    if( !is_ipv4( ip ) ) return {}
    const ip_to_uid = get_tpn_cache( 'miner_ip_to_uid', {} )
    const uid = ip_to_uid?.[ ip ]
    return uid ? { uid: Number( uid ), ip } : {}
}

/**
 * Validator function to get worker config through mining pool.
 * Returns config alongside lease metadata headers for the extension chain.
 * @param {Object} params
 * @param {Object} params.worker - The worker object
 * @param {number} [params.max_retries=2] - The maximum number of retry attempts
 * @param {number} [params.timeout_ms=5_000] - The request timeout in milliseconds
 * @param {string} [params.type='wireguard'] - The type of worker config to retrieve ('wireguard' or 'socks5')
 * @param {string} [params.format='text'] - The response format, either 'text' or 'json'
 * @param {number} [params.lease_seconds=120] - The lease duration in seconds
 * @param {string} params.mining_pool_uid - UID of the mining pool
 * @param {string} params.mining_pool_ip - IP address of the mining pool
 * @param {string} [params.feedback_url] - URL for feedback on the request status
 * @param {string} [params.extend_ref] - Lease reference to extend (forwarded through the mining pool to the worker)
 * @param {string|number} [params.extend_expires_at] - Current expires_at of the lease being extended
 * @param {string} [params.endpoint_url] - Pre-resolved mining pool base URL (skips DB metadata lookup when provided)
 * @returns {Promise<{ config: Object|String, lease_ref: string|null, lease_expires_at: number|null }|null>} - Config with lease metadata
 */
export async function get_worker_config_through_mining_pool( { worker, max_retries=2, timeout_ms=5_000, mining_pool_uid, mining_pool_ip, type='wireguard', format='text', lease_seconds=120, feedback_url, extend_ref, extend_expires_at, endpoint_url } ) {

    // Resolve endpoint — use pre-resolved URL when provided (e.g. extension flow), otherwise look up from DB
    let endpoint
    if( endpoint_url ) {
        endpoint = `${ endpoint_url }/api/lease/new`
    } else {
        const { protocol, url, port } = await read_mining_pool_metadata( { mining_pool_ip, mining_pool_uid } )
        if( !url ) throw new Error( `No URL found in metadata for mining pool ${ mining_pool_uid } at IP ${ mining_pool_ip }` )
        if( !url?.includes( port ) || !url?.includes( protocol ) ) log.warn( `Mining pool URL ${ url } does not include port ${ port } or protocol ${ protocol }, this suggests misconfiguration of the miner` )
        endpoint = `${ url }/api/lease/new`
    }

    // Build query string with optional extension and feedback params
    let query = `?lease_seconds=${ lease_seconds }&format=${ format }&whitelist=${ worker.ip }&type=${ type }`
    if( feedback_url ) query += `&feedback_url=${ encodeURIComponent( feedback_url ) }`
    if( extend_ref ) query += `&extend_ref=${ encodeURIComponent( extend_ref ) }`
    if( extend_expires_at ) query += `&extend_expires_at=${ extend_expires_at }`

    // Mock response if needed
    const { CI_MOCK_MINING_POOL_RESPONSES } = process.env
    if( CI_MOCK_MINING_POOL_RESPONSES === 'true' ) {
        log.info( `CI_MOCK_MINING_POOL_RESPONSES is enabled, returning mock response for ${ endpoint }/${ query }` )
        const mock_config = format === 'json' ? { json_config: { endpoint_ipv4: 'mock.mock.mock.mock' }, text_config: "" } : "Mock WireGuard config"
        return { config: mock_config, lease_ref: null, lease_expires_at: null }
    }

    // Get config through mining pool, reading lease metadata headers alongside the body
    let config = null
    let lease_ref = null
    let lease_expires_at = null
    let attempts = 0
    while( !config && attempts < max_retries ) {

        // Fetch config and extract lease headers from the mining pool response
        attempts++
        const { fetch_options } = abort_controller( { timeout_ms } )
        log.info( `Attempt ${ attempts }/${ max_retries } to get worker config through mining pool at ${ endpoint }${ query }` )
        const result = await fetch( `${ endpoint }${ query }`, fetch_options ).then( async res => {

            // Read lease metadata headers before parsing body
            const ref = res.headers.get( `X-Lease-Ref` )
            const expires = res.headers.get( `X-Lease-Expires` )
            const body = format === `json` ? await res.json() : await res.text()
            return { body, ref, expires }

        } ).catch( e => {
            log.warn( `Error fetching worker config from mining pool ${ mining_pool_uid } on attempt ${ attempts }:`, e.message )
            return null
        } )

        if( result ) {
            config = result.body
            lease_ref = result.ref || null
            lease_expires_at = result.expires ? Number( result.expires ) : null
        }

        log.info( `Received config from mining pool ${ mining_pool_uid } for worker ${ worker.ip }` )

    }

    if( !config ) return null
    return { config, lease_ref, lease_expires_at }

}
