import { cache, log, round_number_to_decimals } from "mentie"
import { get_config_directly_from_worker } from "../networking/worker.js"
import { get_worker_config_through_mining_pool } from "../networking/miners.js"
import { parse_wireguard_config } from "../networking/wireguard.js"
import { run_mode } from "../validations.js"
import { get_worker_config_as_worker } from "../api/worker.js"

/**
 * Annotates workers with wireguard and socks5 configs based on run mode.
 * @param {Object} params
 * @param {Array} params.workers - Worker objects to annotate.
 * @param {string} [params.mining_pool_uid] - Mining pool UID (validator mode).
 * @param {string} [params.mining_pool_ip] - Mining pool IP (validator mode).
 * @param {number} [params.lease_seconds=120] - Lease duration.
 * @param {Function} [params.elapsed_s] - Elapsed time function for tracing.
 * @param {string} [params.cache_key] - Cache key for tracing.
 * @returns {Promise<Array>} New array of workers with configs attached.
 */
export async function add_configs_to_workers( { workers, mining_pool_uid, mining_pool_ip, lease_seconds = 120, elapsed_s, cache_key } ) {

    const { worker_mode, miner_mode, validator_mode } = run_mode()

    // Default elapsed_s function if none provided
    const start = Date.now()
    const get_elapsed = elapsed_s || ( () => round_number_to_decimals( ( Date.now() - start ) / 1000, 2 ) )

    // Helper for optional tracing
    const trace = message => {
        if( cache_key ) cache.merge( cache_key, [ `${ get_elapsed() }s - ${ message }` ] )
    }

    // Fetch configs in parallel, return new worker objects
    const results = await Promise.allSettled( workers.map( async worker => {

        trace( `Fetching worker config for ${ worker.ip }` )

        let wireguard_config = null
        let socks5_config = null

        if( worker_mode ) {

            // Worker generates configs from itself
            wireguard_config = await get_worker_config_as_worker( { type: `wireguard`, lease_seconds, format: `text` } )

            socks5_config = await get_worker_config_as_worker( { type: `socks5`, lease_seconds, format: `text` } )

        } else if( miner_mode ) {

            wireguard_config = await get_config_directly_from_worker( { worker, lease_seconds } )
            socks5_config = await get_config_directly_from_worker( { worker, type: `socks5`, format: `text`, lease_seconds } )

        } else if( validator_mode ) {

            wireguard_config = await get_worker_config_through_mining_pool( { worker, mining_pool_uid, mining_pool_ip, format: `text`, lease_seconds } )
            trace( `Fetched worker config for ${ worker.ip }` )

            socks5_config = await get_worker_config_through_mining_pool( { worker, mining_pool_uid, mining_pool_ip, format: `socks5`, lease_seconds } )
            trace( `Fetched worker socks5 config for ${ worker.ip }` )

        }

        // Build annotated worker
        const annotated = { ...worker }

        if( wireguard_config ) {
            const { text_config } = parse_wireguard_config( { wireguard_config } )
            if( text_config ) annotated.wireguard_config = text_config
        }

        if( socks5_config ) annotated.socks5_config = socks5_config

        // Log warnings on missing configs
        if( !wireguard_config ) log.info( `Error fetching worker config for ${ worker.ip }` )
        if( !socks5_config ) log.info( `Error fetching worker socks5 config for ${ worker.ip }` )

        return annotated

    } ) )

    // Extract values from settled results
    return results.map( result => result.value || result.reason )

}
