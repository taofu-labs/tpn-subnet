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

    // Get config from workers
    let config = null
    let attempts = 0
    while( !config && attempts < relevant_workers?.length ) {

        const worker = relevant_workers[ attempts ]

        // Check that worker consents to be with the mining pool
        const matches = await worker_matches_miner( { worker, mining_pool_url: worker.mining_pool_url } )
        if( !matches ) {
            log.info( `Worker ${ worker.ip } does not consent to be used by mining pool ${ worker.mining_pool_url }, skipping` )
            attempts++
            continue
        }

        // Fetch config
        log.info( `Attempting to get ${ type } config from worker:`, worker )
        const { ip, mining_pool_uid, mining_pool_url } = worker || {}
        const { ip: mining_pool_ip } = await resolve_domain_to_ip( { domain: mining_pool_url } )
        attempts++
        if( !is_ipv4( ip ) ) continue
        config = await get_worker_config_through_mining_pool( { worker, mining_pool_ip, mining_pool_uid, type, format, lease_seconds } ).catch( e => {
            log.info( `Error fetching ${ type } config from worker ${ ip } via mining pool ${ mining_pool_uid }@${ mining_pool_ip }: ${ e.message }` )
            return null
        } )
        if( config ) log.info( `Successfully retrieved ${ type } config from worker ${ ip } via mining pool ${ mining_pool_uid }@${ mining_pool_ip }` )

    }


    // Return the config
    return config
    

}