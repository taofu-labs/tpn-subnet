import { abort_controller, log, sanetise_ipv4, sanetise_string } from "mentie"
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
 * Returns config alongside lease metadata headers for the extension chain.
 * @param {Object} params - Request parameters.
 * @param {Object} params.worker - The worker object.
 * @param {string} params.worker.ip - Worker's IP address.
 * @param {number} [params.worker.public_port=3000] - Worker's public port.
 * @param {number} [params.max_retries=2] - Maximum retry attempts.
 * @param {number} [params.lease_seconds=120] - Lease duration in seconds.
 * @param {string} [params.type='wireguard'] - Type of worker config to retrieve ('wireguard' or 'socks5').
 * @param {string} [params.format='text'] - Response format (text or json).
 * @param {number} [params.timeout_ms=5000] - Request timeout in milliseconds.
 * @param {boolean} [params.priority] - Whether to request a priority slot.
 * @param {string} [params.feedback_url] - URL for workers to check if they won the config race.
 * @param {string} [params.extend_ref] - Lease reference to extend (forwarded to worker).
 * @param {string|number} [params.extend_expires_at] - Current expires_at of the lease being extended.
 * @returns {Promise<{ config: string|Object, lease_ref: string|null, lease_expires_at: number|null }|null>} - Config with lease metadata.
 */
export async function get_config_directly_from_worker( { worker, max_retries=2, lease_seconds=120, type='wireguard', format='text', timeout_ms=5_000, priority, feedback_url, extend_ref, extend_expires_at } ) {

    const { ip, public_port=3000 } = worker
    const { CI_MOCK_WORKER_RESPONSES } = process.env

    // Build query with optional feedback_url for config race resolution
    let query = `http://${ ip }:${ public_port }/api/lease/new?type=${ type }&lease_seconds=${ lease_seconds }&format=${ format }&priority=${ priority ? 'true' : 'false' }`
    if( feedback_url ) query += `&feedback_url=${ encodeURIComponent( feedback_url ) }`
    if( extend_ref ) query += `&extend_ref=${ encodeURIComponent( extend_ref ) }`
    if( extend_expires_at ) query += `&extend_expires_at=${ encodeURIComponent( extend_expires_at ) }`
    log.info( `Fetching ${ type } config directly from worker at ${ query }` )

    // Get config from workers, reading lease metadata headers alongside the body
    let config = null
    let lease_ref = null
    let lease_expires_at = null
    let entry_ip = null
    let exit_ip = null
    let attempts = 0
    while( !config && attempts < max_retries ) {

        // Fetch config and extract lease headers from the response
        attempts++
        const { fetch_options } = abort_controller( { timeout_ms } )
        log.info( `Attempt ${ attempts }/${ max_retries } to get ${ query }` )
        const result = await fetch( query, fetch_options ).then( async res => {

            // Read lease metadata headers before parsing body
            const ref = res.headers.get( `X-Lease-Ref` )
            const expires = res.headers.get( `X-Lease-Expires` )
            const entry = res.headers.get( `X-Entry-Ip` )
            const exit = res.headers.get( `X-Exit-Ip` )
            if( !res.ok ) throw new Error( `Worker ${ ip } returned HTTP ${ res.status }` )
            const body = format === `json` ? await res.json() : await res.text()
            return { body, ref, expires, entry, exit }

        } ).catch( e => {
            log.warn( `Error fetching config from worker ${ ip } on attempt ${ attempts }:`, e.message )
            return null
        } )

        if( result ) {
            config = result.body
            lease_ref = result.ref || null
            lease_expires_at = result.expires ? Number( result.expires ) : null
            entry_ip = result.entry ? sanetise_ipv4( { ip: result.entry, validate: true, error_on_invalid: false } ) : null
            exit_ip = result.exit ? sanetise_ipv4( { ip: result.exit, validate: true, error_on_invalid: false } ) : null
            log.info( `Received ${ type } config from worker ${ ip }` )
        }

    }

    // Warn on no config
    if( !config ) log.warn( `Failed to get ${ type } config from worker ${ ip } after ${ max_retries } attempts` )

    // On mock success
    if( CI_MOCK_WORKER_RESPONSES ) config = config || ( format === 'json' ? { endpoint_ipv4: 'mock.mock.mock.mock' } : "Mock WireGuard config" )

    return { config, lease_ref, lease_expires_at, entry_ip, exit_ip }
}
