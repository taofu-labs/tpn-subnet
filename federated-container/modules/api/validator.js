import { is_ipv4, log, shuffle_array } from "mentie"
import { get_workers } from "../database/workers.js"
import { get_worker_config_through_mining_pool } from "../networking/miners.js"
import { worker_matches_miner } from "../scoring/score_workers.js"
import { resolve_domain_to_ip } from "../networking/network.js"

/**
 * Retrieves worker VPN configuration as a validator by coordinating with mining pools.
 * @param {Object} params - Configuration parameters.
 * @param {string} params.geo - Geographic location code.
 * @param {string} [params.type='wireguard'] - Type of worker config to retrieve ('wireguard' or 'socks5').
 * @param {string} [params.format='text'] - Response format (text or json).
 * @param {string[]} [params.whitelist] - List of whitelisted IPs.
 * @param {string[]} [params.blacklist] - List of blacklisted IPs.
 * @param {number} [params.lease_seconds] - Duration of the lease in seconds.
 * @param {string} [params.connection_type='any'] - Connection type filter ('any', 'datacenter', 'residential').
 * @returns {Promise<string|Object|null>} - Worker configuration or null if no workers available.
 */
export async function get_worker_config_as_validator( { geo, type='wireguard', format='text', whitelist, blacklist, lease_seconds, connection_type='any' } ) {
    
    // Get relevant workers
    let { workers: relevant_workers } = await get_workers( { country_code: geo, status: 'up', limit: 50, randomize: true, connection_type } )
    log.info( `Found ${ relevant_workers.length } relevant workers for geo ${ geo }` )
    if( blacklist?.length ) relevant_workers = relevant_workers.filter( ( { ip } ) => !blacklist.includes( ip ) )
    if( whitelist?.length ) relevant_workers = relevant_workers.filter( ( { ip } ) => whitelist.includes( ip ) )
    log.info( `Filtered to ${ relevant_workers.length } relevant workers for geo ${ geo }` )
    
    // If no workers, exit
    if( !relevant_workers?.length ) {
        log.info( `No workers available for geo ${ geo } after applying whitelist(${ whitelist?.length })/blacklist(${ blacklist?.length })` )
        return null
    }

    // Shuffle the worker ip array
    shuffle_array( relevant_workers )

    // Split the worker array into chunks
    const workers_to_call_at_once = 3
    const amount_of_chunks = Math.ceil( relevant_workers.length / workers_to_call_at_once )
    const chunked_workers = Array.from( { length: amount_of_chunks }, ( _, i ) => {

        // For every chunk, slice from the relevant workers
        const start = i * workers_to_call_at_once
        const end = start + workers_to_call_at_once
        return relevant_workers.slice( start, end )

    } )
    log.info( `Split ${ relevant_workers.length } workers into ${ chunked_workers.length } chunks of up to ${ workers_to_call_at_once } workers each` )

    // Get config from workers
    let config = null
    let attempts = 0
    while( !config && attempts < chunked_workers?.length ) {

        // Get the workers in this chunk
        const workers = chunked_workers[ attempts ]

        // Ask for configs for all workers in chunk, resolve with config from first successful
        log.info( `Attempting to get ${ type } config from chunk ${ attempts + 1 }/${ chunked_workers.length } with ${ workers.length } workers` )
        config = await Promise.any( workers.map( async ( worker ) => {

            // Check if worker matches
            const matches = await worker_matches_miner( { worker, mining_pool_url: worker.mining_pool_url } ).catch( e => false )
            if( !matches ) {
                log.info( `Worker ${ worker.ip } not confirmed to consent to be with the mining pool ${ worker.mining_pool_url }, skipping` )
                throw new Error( `Worker ${ worker.ip } does not consent to mining pool ${ worker.mining_pool_url }` )
            }

            // Validate worker data
            const { ip: worker_ip, mining_pool_url, mining_pool_uid } = worker || {}
            const { ip: mining_pool_ip } = await resolve_domain_to_ip( { domain: mining_pool_url } )
            if( !is_ipv4( worker_ip ) ) throw new Error( `Worker ${ worker_ip } has invalid IP` )
            if( !is_ipv4( mining_pool_ip ) ) throw new Error( `Mining pool ${ mining_pool_uid } has invalid IP` )
            
            // Get config
            const _config = await get_worker_config_through_mining_pool( { worker, mining_pool_ip, mining_pool_uid, type, format, lease_seconds } )
            if( _config ) log.info( `Successfully retrieved ${ type } config from worker ${ worker_ip } via mining pool ${ mining_pool_uid }@${ mining_pool_ip }` )
            return _config

        } ) ).catch( e => {
            log.info( `Error fetching ${ type } config from chunk ${ attempts + 1 }/${ chunked_workers.length }: ${ e.message }` )
            return null
        } )


    }


    // Return the config
    return config
    

}