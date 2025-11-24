import { abort_controller, log, sanetise_string } from "mentie"
const { SERVER_PUBLIC_PORT=3000 } = process.env

/**
 * Gets the configured mining pool URL for the worker, with fallback.
 * @returns {string} - The mining pool URL.
 */
export const get_worker_mining_pool_url = () => {

    // Get url setting
    let { MINING_POOL_URL: _MINING_POOL_URL } = process.env

    // Check if set at all
    const fallback_pool = `http://165.227.133.192:3000`
    if( !`${ _MINING_POOL_URL }`.length ) return fallback_pool

    // Sanetise
    _MINING_POOL_URL = sanetise_string( _MINING_POOL_URL )
    
    // Remove trailing slashes
    _MINING_POOL_URL = _MINING_POOL_URL.replace( /\/+$/, '' )

    return _MINING_POOL_URL

}

export const MINING_POOL_URL = get_worker_mining_pool_url()

/**
 * Fetches WireGuard configuration directly from a worker node.
 * @param {Object} params - Request parameters.
 * @param {Object} params.worker - The worker object.
 * @param {string} params.worker.ip - Worker's IP address.
 * @param {number} [params.worker.public_port=3000] - Worker's public port.
 * @param {number} [params.max_retries=1] - Maximum retry attempts.
 * @param {number} [params.lease_seconds=120] - Lease duration in seconds.
 * @param {string} [params.type='wireguard'] - Type of worker config to retrieve ('wireguard' or 'socks5').
 * @param {string} [params.format='text'] - Response format (text or json).
 * @param {number} [params.timeout_ms=5000] - Request timeout in milliseconds.
 * @returns {Promise<string|Object>} - WireGuard configuration.
 */
export async function get_config_directly_from_worker( { worker, max_retries=1, lease_seconds=120, type='wireguard', format='text', timeout_ms=5_000 } ) {

    const { ip, public_port=3000 } = worker
    const { CI_MOCK_WORKER_RESPONSES } = process.env
    const query = `http://${ ip }:${ public_port }/api/lease/new?type=${ type }&lease_seconds=${ lease_seconds }&format=${ format }`
    log.info( `Fetching ${ type } config directly from worker at ${ query }` )

    // Get config from workers
    let config = null
    let attempts = 0
    while( !config && attempts < max_retries ) {
    
        // Fetch config
        attempts++
        const { fetch_options } = abort_controller( { timeout_ms } )
        log.info( `Attempt ${ attempts }/${ max_retries } to get ${ query }` )
        config = await fetch( query, fetch_options ).then( res => format === 'json' ? res.json() : res.text() )
        log.info( `Received ${ type } config from worker ${ ip }` )
    
    }

    // On mock success
    if( CI_MOCK_WORKER_RESPONSES ) config = config || format === 'json' ? { endpoint_ipv4: 'mock.mock.mock.mock' } : "Mock WireGuard config"
    
    return config
}