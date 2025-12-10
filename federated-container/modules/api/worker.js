import { log } from "mentie"
import { get_valid_wireguard_config } from "../networking/wg-container.js"
import { parse_wireguard_config } from "../networking/wireguard.js"
import { MINING_POOL_URL } from "../networking/worker.js"
import { mark_config_as_free } from "../database/worker_wireguard.js"
import { base_url } from "../networking/url.js"
import { get_valid_socks5_config } from '../networking/dante-container.js'

/**
 * Gets WireGuard/Socks5 VPN configuration as a worker.
 * @param {Object} params - Configuration parameters.
 * @param {string} [params.type='wireguard'] - Type of worker config to retrieve ('wireguard' or 'socks5').
 * @param {number} params.lease_seconds - Duration of the lease in seconds.
 * @param {boolean} [params.priority] - Whether to prioritize this request.
 * @param {string} [params.format] - Response format (text or json).
 * @param {string} [params.feedback_url] - URL for feedback on the request status.
 * @returns {Promise<string|Object>} - WireGuard configuration in requested format.
 */
export async function get_worker_config_as_worker( { type='wireguard', lease_seconds, priority, format, feedback_url } ) {

    let config = null

    // Get relevant wireguard config
    if( type === 'wireguard' ) {

        const { wireguard_config, peer_id, peer_slots, expires_at, cancelled } = await get_valid_wireguard_config( { lease_seconds, priority, feedback_url } )
        if( cancelled ) {
            log.info( `Lease request cancelled according to feedback URL ${ feedback_url }, not returning any config` )
            return {}
        }
        if( !wireguard_config ) throw new Error( `Failed to get valid wireguard config for ${ lease_seconds }, ${ priority ? 'with' : 'without' } priority` )
        log.info( `Obtained WireGuard config for peer_id ${ peer_id } with ${ peer_slots } slots, expires at ${ new Date( expires_at ).toISOString() }` )

        // Return right format
        const { json_config, text_config } = parse_wireguard_config( { wireguard_config } )
        if( format == 'text' ) config = text_config
        else config = json_config
    }

    // Get relevant socks5 config
    if( type === 'socks5' ) {
        const { socks5_config, expires_at } = await get_valid_socks5_config( { lease_seconds } )
        if( !socks5_config ) throw new Error( `Failed to get valid socks5 config for ${ lease_seconds }, ${ priority ? 'with' : 'without' } priority` )
        log.info( `Obtained Socks5 config for ${ socks5_config?.username }, expires at ${ new Date( expires_at ).toISOString() }` )

        // Return right format
        const json_config = socks5_config
        const text_config = `socks5://${ socks5_config.username }:${ socks5_config.password }@${ socks5_config.ip_address }:${ socks5_config.port }`
        if( format == 'text' ) config = text_config
        else config = json_config
    }

    return config

}

/**
 * Registers the worker with the mining pool.
 * @returns {Promise<{ registered: boolean, worker: object }>}
 */
export async function register_with_mining_pool() {

    try { 

        // Get worker configs
        const public_url = base_url
        const { PAYMENT_ADDRESS_EVM, PAYMENT_ADDRESS_BITTENSOR, SERVER_PUBLIC_PORT=3000 } = process.env

        // Get required registration info
        const { wireguard_config, peer_id } = await get_valid_wireguard_config( { lease_seconds: 120, priority: true } )
        const query = `${ MINING_POOL_URL }/miner/broadcast/worker`
        const post_data = { wireguard_config, mining_pool_url: MINING_POOL_URL, public_url, public_port: SERVER_PUBLIC_PORT, payment_address_evm: PAYMENT_ADDRESS_EVM, payment_address_bittensor: PAYMENT_ADDRESS_BITTENSOR }
        log.info( `Registering with mining pool ${ MINING_POOL_URL } at ${ query }` )

        // Post to the miner
        const { registered, worker, error } = await fetch( query, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify( post_data )
        } ).then( res => res.json() )
        if( !error ) log.info( `Registered with mining pool ${ MINING_POOL_URL } as: `, worker )
        if( error ) {
            log.warn( `Error registering with mining pool ${ MINING_POOL_URL }: ${ error }` )
            // Mark the config as free again, if the mining pool did not accept it then there is no conflict risk
            await mark_config_as_free( { peer_id } )
        }

        return { registered, worker }
        
    } catch ( e ) {
        log.error( `Error registering with mining pool ${ MINING_POOL_URL }: `, e.message )
        log.insane( e )
        return { registered: false, error: e.message }
    }

}