import { abort_controller, log } from "mentie"
import { get_valid_wireguard_config, monitor_lease_ownership, read_wireguard_peer_config } from "../networking/wg-container.js"
import { parse_wireguard_config } from "../networking/wireguard.js"
import { MINING_POOL_URL } from "../networking/worker.js"
import { base_url, parse_url } from "../networking/url.js"
import { get_valid_socks5_config } from '../networking/dante-container.js'
import { add_configs_to_workers } from "../scoring/query_workers.js"
import { extend_wireguard_lease } from "../database/worker_wireguard.js"
import { extend_socks5_lease , read_socks5_config_by_username } from "../database/worker_socks5.js"

/**
 * Gets WireGuard/Socks5 VPN configuration as a worker.
 * Supports both new lease allocation and extending an existing lease via `extend_ref`.
 * @param {Object} params - Configuration parameters.
 * @param {string} [params.type='wireguard'] - Type of worker config to retrieve ('wireguard' or 'socks5').
 * @param {number} params.lease_seconds - Duration of the lease in seconds.
 * @param {boolean} [params.priority] - Whether to prioritize this request.
 * @param {string} [params.format] - Response format (text or json).
 * @param {string} [params.feedback_url] - URL for feedback on the request status.
 * @param {string} [params.extend_ref] - Lease reference to extend (peer_id for wireguard, username for socks5).
 * @param {string|number} [params.extend_expires_at] - Current expires_at of the lease being extended (reallocation guard).
 * @returns {Promise<{ config: string|Object, lease_ref: string|number, lease_expires_at: number }|Object>} - Config with lease metadata.
 */
export async function get_worker_config_as_worker( { type='wireguard', lease_seconds, priority, format='text', feedback_url, extend_ref, extend_expires_at } ) {

    let config = null
    let lease_ref = null
    let lease_expires_at = null

    // Extract trace from feedback URL for log correlation across hops
    let log_tag = ``
    if( feedback_url ) {
        const { trace } = parse_url( { url: feedback_url, params: [ 'trace' ], decode: true } )
        if( trace ) log_tag = `[${ trace }] `
    }

    // --- Extension branch: extend an existing lease instead of allocating a new one ---
    if( extend_ref ) {

        // Validate extension inputs before proceeding
        const expected_expires_at = Number( extend_expires_at )
        if( !Number.isFinite( expected_expires_at ) ) throw new Error( `Invalid extend_expires_at: must be a finite timestamp` )
        if( type === `wireguard` && !Number.isFinite( Number( extend_ref ) ) ) throw new Error( `Invalid extend_ref for wireguard: must be a numeric peer_id` )
        if( ![ `wireguard`, `socks5` ].includes( type ) ) throw new Error( `Unsupported type for lease extension: ${ type }` )

        const new_expires_at = Date.now() +  lease_seconds * 1000 

        if( type === `wireguard` ) {

            const peer_id = Number( extend_ref )
            log.info( `${ log_tag }Extending WireGuard lease peer${ peer_id } to ${ new Date( new_expires_at ).toISOString() }` )
            const result = await extend_wireguard_lease( { peer_id, expected_expires_at, new_expires_at } )

            // Re-read the peer config from disk
            const wireguard_config = await read_wireguard_peer_config( { peer_id } )
            const { json_config, text_config } = parse_wireguard_config( { wireguard_config } )
            config = format === `text` ? text_config : json_config
            lease_ref = peer_id
            lease_expires_at = result.expires_at

        }

        if( type === `socks5` ) {

            const username = `${ extend_ref }`
            log.info( `${ log_tag }Extending SOCKS5 lease ${ username } to ${ new Date( new_expires_at ).toISOString() }` )
            const result = await extend_socks5_lease( { username, expected_expires_at, new_expires_at } )

            // Read the config back from DB
            const socks5_config = await read_socks5_config_by_username( { username } )
            if( !socks5_config ) throw new Error( `SOCKS5 config not found for ${ username } after extension` )
            const text_config = `socks5://${ socks5_config.username }:${ socks5_config.password }@${ socks5_config.ip_address }:${ socks5_config.port }`
            config = format === `text` ? text_config : socks5_config
            lease_ref = username
            lease_expires_at = result.expires_at

        }

        log.info( `${ log_tag }Lease extension complete for ${ type } ref=${ lease_ref }, new expires_at=${ new Date( lease_expires_at ).toISOString() }` )
        return { config, lease_ref, lease_expires_at }

    }

    // --- New lease branch: allocate a fresh config ---

    // Get relevant wireguard config
    if( type === 'wireguard' ) {

        const { wireguard_config, peer_id, peer_slots, expires_at, cancelled } = await get_valid_wireguard_config( { lease_seconds, priority, feedback_url } )
        if( cancelled ) {
            log.info( `Lease monitor: ${ log_tag }lost the race (config cancelled by feedback URL)` )
            return {}
        }
        if( !wireguard_config ) throw new Error( `Failed to get valid wireguard config for ${ lease_seconds }, ${ priority ? 'with' : 'without' } priority` )
        log.info( `Obtained WireGuard config  ${ priority ? 'with' : 'without' } for peer_id ${ peer_id } with ${ peer_slots } slots, expires at ${ new Date( expires_at ).toISOString() }` )

        // Return right format
        const { json_config, text_config } = parse_wireguard_config( { wireguard_config } )
        if( format == 'text' ) config = text_config
        else config = json_config

        lease_ref = peer_id
        lease_expires_at = expires_at

        // Fire-and-forget: monitor whether we won the race, release lease if we lost
        if( feedback_url && peer_id ) {
            monitor_lease_ownership( { peer_id, feedback_url, expires_at } )
                .catch( e => log.warn( `Lease monitor: ${ log_tag }peer${ peer_id } error:`, e ) )
        }
    }

    // Get relevant socks5 config
    if( type === 'socks5' ) {
        const { socks5_config, expires_at } = await get_valid_socks5_config( { lease_seconds, priority } )
        if( !socks5_config ) throw new Error( `Failed to get valid socks5 config for ${ lease_seconds }, ${ priority ? 'with' : 'without' } priority` )
        log.info( `Obtained Socks5 config ${ priority ? 'with' : 'without' } priority for ${ socks5_config?.username }, expires at ${ new Date( expires_at ).toISOString() }` )

        // Return right format
        const json_config = socks5_config
        const text_config = `socks5://${ socks5_config.username }:${ socks5_config.password }@${ socks5_config.ip_address }:${ socks5_config.port }`
        if( format == 'text' ) config = text_config
        else config = json_config

        lease_ref = socks5_config.username
        lease_expires_at = expires_at
    }

    return { config, lease_ref, lease_expires_at }

}

/**
 * Registers the worker with the mining pool.
 * @returns {Promise<{ registered: boolean, worker: object }>}
 */
export async function register_with_mining_pool() {

    try {

        const public_url = base_url
        const { PAYMENT_ADDRESS_EVM, PAYMENT_ADDRESS_BITTENSOR, SERVER_PUBLIC_PORT=3000 } = process.env

        // Create base worker object
        const base_worker = {
            mining_pool_url: MINING_POOL_URL,
            public_url,
            public_port: SERVER_PUBLIC_PORT,
            payment_address_evm: PAYMENT_ADDRESS_EVM,
            payment_address_bittensor: PAYMENT_ADDRESS_BITTENSOR
        }

        // Add configs using unified function
        const [ worker_with_configs ] = await add_configs_to_workers( {
            workers: [ base_worker ],
            lease_seconds: 120
        } )

        // Post to the miner
        const query = `${ MINING_POOL_URL }/miner/broadcast/worker`
        log.info( `Registering with mining pool ${ MINING_POOL_URL } at ${ query } with`, worker_with_configs )

        // Timeout after 60s to prevent hanging on unresponsive pools
        const { fetch_options } = abort_controller( { timeout_ms: 60_000 } )
        const { registered, worker, error } = await fetch( query, {
            ...fetch_options,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify( worker_with_configs )
        } ).then( res => res.json() )

        if( !error ) log.info( `Registered with mining pool ${ MINING_POOL_URL } as: `, worker )
        if( error ) log.warn( `Error registering with mining pool ${ MINING_POOL_URL }: ${ error }` )

        return { registered, worker }

    } catch ( e ) {
        log.error( `Error registering with mining pool ${ MINING_POOL_URL }: `, e.message )
        log.insane( e )
        return { registered: false, error: e.message }
    }

}