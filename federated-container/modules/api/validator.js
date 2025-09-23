import { is_ipv4, log, shuffle_array } from "mentie"
import { get_workers } from "../database/workers.js"
import { get_worker_config_through_mining_pool } from "../networking/miners.js"
import { worker_matches_miner } from "../scoring/score_workers.js"
import { resolve_domain_to_ip } from "../networking/network.js"

export async function get_worker_config_as_validator( { geo, whitelist, blacklist, lease_seconds } ) {

    // Do payment authentication here in future
    // ...
    
    // Get relevant workers
    let { workers: relevant_workers } = await get_workers( { country_code: geo, status: 'up', limit: 50, randomize: true } )
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
        log.info( `Attempting to get config from worker:`, worker )
        const { ip, mining_pool_uid, mining_pool_url } = worker || {}
        const { ip: mining_pool_ip } = await resolve_domain_to_ip( { domain: mining_pool_url } )
        attempts++
        if( !is_ipv4( ip ) ) continue
        config = await get_worker_config_through_mining_pool( { worker_ip: ip, mining_pool_ip, mining_pool_uid } )
        if( config ) log.info( `Successfully retrieved config from worker ${ ip } via mining pool ${ mining_pool_uid }@${ mining_pool_ip }` )

    }


    // Return the config
    return config
    

}