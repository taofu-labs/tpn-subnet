import { cache, is_ipv4, log, shuffle_array } from "mentie"
import { get_workers } from "../database/workers.js"
import { get_worker_config_through_mining_pool } from "../networking/miners.js"
import { resolve_domain_to_ip } from "../networking/network.js"
import { base_url } from "../networking/url.js"
import { match_worker_to_pool } from "../scoring/score_workers.js"
import { v4 as uuidv4 } from 'uuid'
import { sign_lease_token, verify_lease_token } from "../crypto/lease_token.js"
import { is_partnered_pool } from "../partnered_pools.js"

/**
 * Retrieves worker VPN configuration as a validator by coordinating with mining pools.
 * Supports both new lease allocation and extending an existing lease via `lease_token`.
 * @param {Object} params - Configuration parameters.
 * @param {string} params.geo - Geographic location code.
 * @param {string} [params.type='wireguard'] - Type of worker config to retrieve ('wireguard' or 'socks5').
 * @param {string} [params.format='text'] - Response format (text or json).
 * @param {string[]} [params.whitelist] - List of whitelisted IPs.
 * @param {string[]} [params.blacklist] - List of blacklisted IPs.
 * @param {number} [params.lease_seconds] - Duration of the lease in seconds.
 * @param {string} [params.connection_type='any'] - Connection type filter ('any', 'datacenter', 'residential').
 * @param {string} [params.lease_token] - Signed opaque token from a previous lease, triggers extension flow.
 * @returns {Promise<{_lease_result: true, config: string|Object, connection_type: string|null, country: string|null, lease_token: string|null}|null>} - Wrapped config with resolved worker metadata and optional lease token.
 */
export async function get_worker_config_as_validator( { geo, type='wireguard', format='text', whitelist, blacklist, lease_seconds, connection_type='any', lease_token } ) {

    // --- Extension branch: verify token and route directly to the original worker ---
    if( lease_token ) {
        return extend_lease_as_validator( { lease_token, lease_seconds, format } )
    }

    // --- New lease branch: normal worker discovery ---

    // Get relevant workers — push whitelist/blacklist filtering into the DB query
    const has_whitelist = whitelist?.length > 0
    let { workers: relevant_workers } = await get_workers( {
        country_code: geo, status: 'up',
        ips: has_whitelist ? whitelist : undefined,
        exclude_ips: blacklist?.length ? blacklist : undefined,
        limit: has_whitelist ? null : 50,
        randomize: !has_whitelist,
        connection_type
    } )
    log.info( `Found ${ relevant_workers.length } relevant workers for geo ${ geo }` )

    // If no workers, exit
    if( !relevant_workers?.length ) {
        log.info( `No workers available for geo ${ geo } after applying whitelist(${ whitelist?.length })/blacklist(${ blacklist?.length })` )
        return null
    }

    // Shuffle the worker ip array
    shuffle_array( relevant_workers )

    // Split the worker array into chunks
    const workers_to_call_at_once = 10
    const amount_of_chunks = Math.ceil( relevant_workers.length / workers_to_call_at_once )
    const chunked_workers = Array.from( { length: amount_of_chunks }, ( _, i ) => {

        // For every chunk, slice from the relevant workers
        const start = i * workers_to_call_at_once
        const end = start + workers_to_call_at_once
        return relevant_workers.slice( start, end )

    } )
    log.info( `Split ${ relevant_workers.length } workers into ${ chunked_workers.length } chunks of up to ${ workers_to_call_at_once } workers each` )

    // Set up feedback url (nonce is added per-call to identify the winner)
    const request_id = uuidv4()
    const base_feedback_url = `${ base_url }/api/request/${ request_id }`

    // Get config from workers
    let config = null
    let attempts = 0
    while( !config && attempts < chunked_workers?.length ) {

        // Get the workers in this chunk
        const workers = chunked_workers[ attempts ]

        // Ask for configs for all workers in chunk, resolve with config from first successful
        log.info( `Attempting to get ${ type } config from chunk ${ attempts + 1 }/${ chunked_workers.length } with ${ workers.length } workers` )
        config = await Promise.any( workers.map( async ( worker ) => {

            // Generate a unique nonce for this call so we can identify the winner
            const call_nonce = uuidv4()
            const feedback_url = `${ base_feedback_url }?nonce=${ call_nonce }&trace=${ request_id }`

            // Validate worker data
            const { ip: worker_ip, mining_pool_url, mining_pool_uid } = worker || {}
            const { ip: mining_pool_ip } = await resolve_domain_to_ip( { domain: mining_pool_url } )
            if( !is_ipv4( worker_ip ) ) throw new Error( `Worker ${ worker_ip } has invalid IP` )
            if( !is_ipv4( mining_pool_ip ) ) throw new Error( `Mining pool ${ mining_pool_uid } has invalid IP` )

            // Check worker consents to mining pool membership (partnered pool workers run custom code, skip direct call)
            const partnered = mining_pool_uid && is_partnered_pool( { mining_pool_uid, mining_pool_ip } )
            if( partnered ) log.debug( `Worker ${ worker_ip } belongs to partnered pool ${ mining_pool_uid }, skipping membership check` )
            if( !partnered ) {
                const { matches } = await match_worker_to_pool( { worker, mining_pool_url } )
                if( !matches ) {
                    log.info( `Worker ${ worker.ip } not confirmed to consent to be with the mining pool ${ mining_pool_url }, skipping` )
                    throw new Error( `Worker ${ worker.ip } does not consent to mining pool ${ mining_pool_url }` )
                }
            }

            // Get config through mining pool — now returns { config, lease_ref, lease_expires_at }
            const pool_result = await get_worker_config_through_mining_pool( { worker, mining_pool_ip, mining_pool_uid, type, format, lease_seconds, feedback_url } )
            if( !pool_result?.config ) throw new Error( `No config obtained from worker ${ worker_ip } through mining pool ${ mining_pool_uid }@${ mining_pool_ip }` )
            log.info( `Successfully retrieved ${ type } config from worker ${ worker_ip } via mining pool ${ mining_pool_uid }@${ mining_pool_ip }` )

            // Return config with the winning nonce and routing info for token signing
            return { pool_result, winner_nonce: call_nonce, worker }

        } ) ).catch( e => {

            // AggregateError is thrown when all promises reject, log all errors
            if( e instanceof AggregateError ) {
                log.info( `Error fetching ${ type } config from chunk ${ attempts + 1 }/${ chunked_workers.length }: All promises rejected.` )
                e.errors.forEach( ( err, idx ) => {
                    log.info( `  [${ idx+1 }] Reason: ${ err && err.message ? err.message : err }` )
                } )
            } else {
                log.info( `Error fetching ${ type } config from chunk ${ attempts + 1 }/${ chunked_workers.length }: ${ e.message }` )
            }
            return null

        } )


        // Increment attempts
        attempts++

    }

    // Extract the race result (config wrapped with winner metadata from Promise.any)
    const winner_nonce = config?.winner_nonce ?? null
    const winning_worker = config?.worker ?? null
    const pool_result = config?.pool_result ?? null
    const resolved_config = pool_result?.config ?? ( config?.winner_nonce ? null : config )

    // When config was obtained, mark request as complete with the winner nonce
    if( resolved_config ) {
        log.debug( `Successfully obtained ${ type } config after ${ attempts } attempts, marking request_${ request_id } as 'complete' in cache` )
        cache( `request_${ request_id }`, { status: 'complete', winner: winner_nonce }, 60_000 )
    }

    // Return config wrapped with resolved worker metadata (available for all formats)
    // Prefer metadata from the mining pool response (already enriched for JSON), fall back to local worker record
    if( !resolved_config ) return null
    const upstream_meta = typeof resolved_config === 'object'
    const meta_connection_type = upstream_meta && resolved_config.connection_type ? resolved_config.connection_type : winning_worker?.connection_type ?? null
    const meta_country = upstream_meta && resolved_config.country ? resolved_config.country : winning_worker?.country_code ?? null

    // Sign a lease token if we have complete lease metadata from the worker chain
    let signed_token = null
    const lease_ref = pool_result?.lease_ref ?? null
    const lease_expires_at = pool_result?.lease_expires_at ?? null
    if( lease_ref && Number.isFinite( lease_expires_at ) && winning_worker ) {
        signed_token = sign_lease_token( {
            config_ref: lease_ref,
            type,
            worker_ip: winning_worker.ip,
            mining_pool_url: winning_worker.mining_pool_url,
            mining_pool_uid: winning_worker.mining_pool_uid,
            expires_at: lease_expires_at,
        } )
    }

    return {
        _lease_result: true,
        config: resolved_config,
        connection_type: meta_connection_type,
        country: meta_country,
        lease_token: signed_token,
        lease_ref,
        lease_expires_at,
        exit_ip: winning_worker?.ip ?? null,
    }


}

/**
 * Extends an existing lease by verifying the signed token and routing directly
 * to the original worker through the same mining pool.
 * @param {Object} params
 * @param {string} params.lease_token - The signed opaque token from a previous lease
 * @param {number} params.lease_seconds - New duration from now in seconds
 * @param {string} [params.format='text'] - Response format
 * @returns {Promise<{_lease_result: true, config: string|Object, connection_type: string|null, country: string|null, lease_token: string}>}
 */
async function extend_lease_as_validator( { lease_token, lease_seconds, format='text' } ) {

    // Decode and verify the token — throws on tamper or invalid signature
    const decoded = verify_lease_token( lease_token )
    const { config_ref, type, worker_ip, mining_pool_url, mining_pool_uid, expires_at } = decoded
    log.info( `Extending lease: type=${ type } ref=${ config_ref } worker=${ worker_ip } pool=${ mining_pool_uid }` )

    // Resolve mining pool IP from the stored URL
    const { ip: mining_pool_ip } = await resolve_domain_to_ip( { domain: mining_pool_url } )
    if( !is_ipv4( mining_pool_ip ) ) throw new Error( `Failed to resolve mining pool ${ mining_pool_url } to a valid IP` )

    // Build a synthetic worker object from the decoded token for the mining pool call
    const worker = { ip: worker_ip }

    // Route the extension through the mining pool using the URL from the token (no DB lookup needed)
    const pool_result = await get_worker_config_through_mining_pool( {
        worker,
        mining_pool_ip,
        mining_pool_uid,
        type,
        format,
        lease_seconds,
        extend_ref: config_ref,
        extend_expires_at: expires_at,
        endpoint_url: mining_pool_url,
    } )

    if( !pool_result?.config ) throw new Error( `Lease extension failed: no config returned for ref=${ config_ref } worker=${ worker_ip }` )

    // Re-sign a new token with the updated expires_at from the worker response
    const new_expires_at = pool_result.lease_expires_at ??  Date.now() + lease_seconds * 1000 
    const new_token = sign_lease_token( {
        config_ref: pool_result.lease_ref ?? config_ref,
        type,
        worker_ip,
        mining_pool_url,
        mining_pool_uid,
        expires_at: new_expires_at,
    } )

    log.info( `Lease extension complete: ref=${ config_ref } new_expires=${ new Date( new_expires_at ).toISOString() }` )

    return {
        _lease_result: true,
        config: pool_result.config,
        connection_type: null,
        country: null,
        lease_token: new_token,
        lease_ref: pool_result.lease_ref ?? config_ref,
        lease_expires_at: new_expires_at,
        exit_ip: worker_ip,
    }

}
