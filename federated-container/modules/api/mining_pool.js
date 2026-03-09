import { abort_controller, cache, is_ipv4, log, shuffle_array } from "mentie"
import { v4 as uuidv4 } from 'uuid'
import { get_config_directly_from_worker } from "../networking/worker.js"
import { get_validators } from "../networking/validators.js"
import { get_workers } from "../database/workers.js"
import { base_url, parse_url } from "../networking/url.js"
const { CI_MODE, CI_MOCK_MINING_POOL_RESPONSES } = process.env
let { SERVER_PUBLIC_PORT: port=3000, SERVER_PUBLIC_PROTOCOL: protocol='http', SERVER_PUBLIC_HOST } = process.env


/**
 * Retrieves WireGuard configuration from a worker as a mining pool.
 * @param {Object} params - Configuration parameters.
 * @param {string} params.geo - Geographic location code.
 * @param {string} [params.type='wireguard'] - Type of worker config to retrieve ('wireguard' or 'socks5').
 * @param {string} [params.format='text'] - Response format (text or json).
 * @param {string[]} [params.whitelist] - List of whitelisted IPs.
 * @param {string[]} [params.blacklist] - List of blacklisted IPs.
 * @param {number} [params.lease_seconds] - Duration of the lease in seconds.
 * @param {boolean} [params.priority] - Whether to request a priority slot from the worker.
 * @param {string} [params.feedback_url] - Upstream feedback URL (e.g. from validator) for cascade race resolution.
 * @returns {Promise<{_lease_result: true, config: string|Object, connection_type: string|null, country: string|null}|null>} - Wrapped config with resolved worker metadata, or null if no workers available.
 */
export async function get_worker_config_as_miner( { geo, type='wireguard', format='text', whitelist, blacklist, lease_seconds, priority, feedback_url: upstream_feedback_url } ) {

    // Get relevant workers — push whitelist/blacklist filtering into the DB query
    const has_whitelist = whitelist?.length > 0
    let { workers: relevant_workers } = await get_workers( {
        country_code: geo, mining_pool_uid: 'internal', status: 'up',
        ips: has_whitelist ? whitelist : undefined,
        exclude_ips: blacklist?.length ? blacklist : undefined,
        limit: has_whitelist ? null : 50
    } )
    log.info( `Found ${ relevant_workers.length } relevant workers for geo ${ geo }` )

    // If no workers, exit
    if( CI_MOCK_MINING_POOL_RESPONSES !== 'true' && !relevant_workers?.length ) {
        log.info( `No workers available for geo ${ geo } after applying whitelist(${ whitelist?.length })/blacklist(${ blacklist?.length })` )
        return null
    }

    // Shuffle the worker ip array
    shuffle_array( relevant_workers )

    // Generate own feedback_url for internal race resolution (nonce is added per-worker)
    const request_id = uuidv4()
    const base_feedback_url = `${ base_url }/api/request/${ request_id }`

    // Store upstream feedback URL (e.g. from validator) for cascade checking by workers
    if( upstream_feedback_url ) cache( `request_upstream_${ request_id }`, { url: upstream_feedback_url }, 120_000 )

    // Propagate trace from upstream, or start a new trace when this pool is the origin
    let trace_id = request_id
    if( upstream_feedback_url ) {
        const { trace } = parse_url( { url: upstream_feedback_url, params: [ 'trace' ] } )
        if( trace ) trace_id = trace
    }

    // Filter to valid IPv4 workers and chunk them for parallelized querying
    const valid_workers = relevant_workers.filter( w => is_ipv4( w.ip ) )
    const workers_per_chunk = 10
    const chunk_count = Math.ceil( valid_workers.length / workers_per_chunk )
    const chunked_workers = Array.from( { length: chunk_count }, ( _, i ) =>
        valid_workers.slice( i * workers_per_chunk, ( i + 1 ) * workers_per_chunk )
    )

    log.info( `Split ${ valid_workers.length } workers into ${ chunked_workers.length } chunks of up to ${ workers_per_chunk } workers each` )

    // Query workers chunk by chunk until we get a config
    let config = null

    for( const [ index, chunk ] of chunked_workers.entries() ) {

        log.info( `Attempting to get ${ type } config from chunk ${ index + 1 }/${ chunked_workers.length } with ${ chunk.length } workers` )

        // Query all workers in chunk simultaneously, return first success
        // Wrap calls so null results reject (Promise.any only rejects on thrown errors)
        config = await Promise.any(
            chunk.map( async worker => {

                // Generate a unique nonce per worker so we can identify the winner
                const worker_nonce = uuidv4()
                const feedback_url = `${ base_feedback_url }?nonce=${ worker_nonce }&trace=${ trace_id }`

                const result = await get_config_directly_from_worker( { worker, type, format, lease_seconds, priority, feedback_url } )
                if( !result ) throw new Error( `No config from ${ worker.ip }` )

                return { config: result, winner_nonce: worker_nonce, worker }
            } )
        ).catch( e => {
            if( e instanceof AggregateError ) log.info( `Chunk ${ index + 1 } failed: all ${ chunk.length } workers rejected` )
            return null
        } )

        if( config ) break

    }

    // Extract the race result (config wrapped with winner metadata from Promise.any)
    const winner_nonce = config?.winner_nonce ?? null
    const winning_worker = config?.worker ?? null
    const resolved_config = config?.winner_nonce ? config.config : config

    // Mark request complete with winner so losing workers can free their configs
    if( resolved_config ) {
        cache( `request_${ request_id }`, { status: 'complete', winner: winner_nonce }, 60_000 )
        log.info( `Marked request ${ request_id } as complete, winner nonce: ${ winner_nonce }` )
    }

    // On mock success, return a fake config in the same wrapper shape
    if( CI_MOCK_MINING_POOL_RESPONSES === 'true' ) return {
        _lease_result: true,
        config: format === 'json' ? { endpoint_ipv4: 'mock.mock.mock.mock' } : `Mock ${ type } config`,
        connection_type: null,
        country: null,
    }

    // Return config wrapped with resolved worker metadata (available for all formats)
    if( !resolved_config ) return null
    return {
        _lease_result: true,
        config: resolved_config,
        connection_type: winning_worker?.connection_type ?? null,
        country: winning_worker?.country_code ?? null,
    }

}

/**
 * Registers the mining pool with all known validators.
 * @returns {Promise<{successes: Array, failures: Array}>} - Registration results with successes and failures.
 */
export async function register_mining_pool_with_validators() {

    // Get validator ip list
    const validator_ips = await get_validators( { ip_only: true } )

    // Formulate identity
    const identity = { protocol, url: base_url, port }
    log.info( `Registering mining pool with validators:`, identity )

    // Register with validators with allSettled
    const results = await Promise.allSettled( validator_ips.map( async ip => {
        
        // Get protocol data from validator
        const { fetch_options: broadcast_options } = abort_controller( { timeout_ms: 60_000 } )
        const validator_broadcast = await fetch( `http://${ ip }:3000/`, broadcast_options ).then( res => res.json() )

        // Formulate registration request
        const { fetch_options: register_options } = abort_controller( { timeout_ms: 30_000 } )
        const body = JSON.stringify( identity )
        const protocol = validator_broadcast.SERVER_PUBLIC_PROTOCOL || 'http'
        const host = validator_broadcast.SERVER_PUBLIC_HOST || ip
        const port = validator_broadcast.SERVER_PUBLIC_PORT || 3000
        const url = `${ protocol }://${ host }:${ port }/validator/broadcast/mining_pool`
        return fetch( url, {
            ...register_options,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
        } ).then( res => res.json() )

    } ) )

    const [ successes, failures ] = results.reduce( ( acc, result ) => {
        if( result.status === 'fulfilled' ) acc[ 0 ].push( result.value )
        else acc[ 1 ].push( result.reason )
        return acc
    }, [ [], [] ] )
    log.info( `Registered mining pool successfully with ${ successes.length } validators, failed: ${ failures.length }` )
    log.debug( `Failed registrations: `, failures )

    return { successes, failures }

}

/**
 * Registers all mining pool workers with validators by broadcasting worker list.
 * @returns {Promise<{successes: Array, failures: Array}>} - Registration results with successes and failures.
 */
export async function register_mining_pool_workers_with_validators() {

    // Get validator ip list
    const validator_ips = await get_validators( { ip_only: true } )

    // Get all worker data and structure it
    const { workers } = await get_workers( { mining_pool_uid: 'internal' } )
    log.info( `Broadcasting ${ workers.length } workers to ${ validator_ips.length } validators` )

    // Register with validators with allSettled
    const results = await Promise.allSettled( validator_ips.map( async ip => {

        // Get protocol data from validator
        const { fetch_options: broadcast_options } = abort_controller( { timeout_ms: 60_000 } )
        const validator_broadcast = await fetch( `http://${ ip }:3000/`, broadcast_options ).then( res => res.json() )

        // Formulate registration request
        const { fetch_options: register_options } = abort_controller( { timeout_ms: 30_000 } )
        const body = JSON.stringify( { workers } )
        const protocol = validator_broadcast.SERVER_PUBLIC_PROTOCOL || 'http'
        const host = validator_broadcast.SERVER_PUBLIC_HOST || ip
        const port = validator_broadcast.SERVER_PUBLIC_PORT || 3000
        const url = `${ protocol }://${ host }:${ port }/validator/broadcast/workers`
        log.info( `Registering at ${ url } with ${ workers.length } workers.`, CI_MODE === 'true' ? body : '' )
        const registration = await fetch( url, {
            ...register_options,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
        } ).then( res => res.json() )
        log.info( `Registered ${ workers.length } workers with validator at ${ url }` )
        return registration

    } ) )

    const [ successes, failures ] = results.reduce( ( acc, result ) => {
        if( result.status === 'fulfilled' ) acc[ 0 ].push( result.value )
        else acc[ 1 ].push( result.reason )
        return acc
    }, [ [], [] ] )
    log.info( `Registered ${ workers.length } workers with validators, successful: ${ successes.length }, failed: ${ failures.length }` )
    log.debug( `Failed registrations: `, failures )

    return { successes, failures }

}