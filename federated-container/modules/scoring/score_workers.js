import { abort_controller, log } from "mentie"
import { try_acquire_lock } from "../locks.js"
import { parse_wireguard_config, test_wireguard_connection } from "../networking/wireguard.js"
import { default_mining_pool, is_valid_worker, run_mode } from "../validations.js"
import { ip_geodata } from "../geolocation/helpers.js"
import { get_workers, write_workers, write_worker_performance } from "../database/workers.js"
import { add_configs_to_workers } from "./query_workers.js"
import { map_ips_to_geodata } from "../geolocation/ip_mapping.js"
import { test_socks5_connection } from "../networking/socks5.js"
import { score_node_version } from "./score_node.js"
const { CI_MODE, CI_MOCK_WORKER_RESPONSES } = process.env

/**
 * Tests and scores all known workers registered with the mining pool.
 * @param {number} [max_duration_minutes=15] - Maximum duration in minutes before function times out.
 * @returns {Promise<void>}
 */
export async function score_all_known_workers( max_duration_minutes=15 ) {

    // Warn if function was is called by non miner
    const { miner_mode } = run_mode()
    if( !miner_mode ) log.warn( `score_all_known_workers called while not in miner mode, this may be unintended` )

    // Try to acquire lock - if already running, return early
    log.info( `Starting score_all_known_workers, max duration ${ max_duration_minutes } minutes` )
    const release_lock = await try_acquire_lock( `score_all_known_workers` )
    if( !release_lock ) return log.warn( `score_all_known_workers is already running` )

    try {

        // Get all known workers
        const { workers } = await get_workers( { mining_pool_uid: 'internal' } )
        if( !workers?.length ) return log.info( `No known workers to score` )
        if( CI_MODE === 'true' ) log.info( `Got ${ workers.length } workers to score, first: `, workers?.[0] )

        // Fetch wireguard and socks5 configs from each worker
        log.info( `Fetching wireguard config from ${ workers.length } workers...` )
        const workers_with_configs = await add_configs_to_workers( { workers } )

        // Test all known workers
        const { successes, failures } = await validate_and_annotate_workers( { workers_with_configs } )

        // Save all worker data
        const annotated_workers = [
            ...successes.map( worker => ( { ...worker, status: 'up' } ) ),
            ...failures.map( worker => ( { ...worker, status: 'down' } ) )
        ]

        // Save worker ips to db
        await map_ips_to_geodata( { ips: successes.map( worker => worker.ip ), cache_prefix: 'worker', prefix_merge: true } )

        // Save annotated workers to database
        await write_workers( { workers: annotated_workers, mining_pool_uid: 'internal' } )

        // Write worker scores to database
        await write_worker_performance( { workers: annotated_workers } )

        log.info( `Scored all known workers, ${ successes.length } successes, ${ failures.length } failures` )

    } catch ( e ) {
        log.error( `Error scoring all known workers:`, e )
    } finally {

        // Release the mutex lock
        release_lock()

    }

}

/**
 * Verifies that a worker is associated with the expected mining pool.
 * @param {Object} params - Verification parameters.
 * @param {Object} params.worker - Worker object.
 * @param {string} params.worker.ip - IP address of the worker.
 * @param {number} params.worker.public_port - Public port of the worker.
 * @param {string} params.mining_pool_url - Expected URL of the mining pool.
 * @param {boolean} [params.throw_on_mismatch=false] - Whether to throw an error on mismatch.
 * @param {number} [params.timeout_ms=5_000] - Timeout in ms for the worker membership check.
 * @returns {Promise<boolean>} - True if worker matches miner, false otherwise.
 */
export async function worker_matches_miner( { worker, mining_pool_url, throw_on_mismatch=false, timeout_ms=5_000 } ) {

    try {

        // Check that the worker broadcasts mining pool membership
        const mock_pool_check = CI_MOCK_WORKER_RESPONSES === 'true'
        const { fetch_options } = abort_controller( { timeout_ms } )
        const { MINING_POOL_URL } = mock_pool_check ? { MINING_POOL_URL: 'http://mock.mock.mock.mock' } : await fetch( `http://${ worker.ip }:${ worker.public_port }`, fetch_options ).then( res => res.json() )
        if( !mock_pool_check && !MINING_POOL_URL ) throw new Error( `Worker does not broadcast mining pool membership` )
        if( CI_MODE !== 'true' && MINING_POOL_URL !== mining_pool_url && MINING_POOL_URL !== default_mining_pool ) throw new Error( `Worker broadcast ${ MINING_POOL_URL } which does not correspond to our expectation of ${ mining_pool_url }` )

        return true
    
    } catch ( e ) {
        log.info( `Error checking worker ${ worker.ip } matches miner at ${ mining_pool_url }: ${ e.message }:`, e )
        if( throw_on_mismatch ) throw e
        return false
    }
}

/**
 * Checks whether the worker objects are valid and work
 * @param {Object} params
 * @param {Array} params.workers_with_configs
 * @param {string} params.workers_with_configs[].ip - IP address of the worker
 * @param {string} params.workers_with_configs[].wireguard_config - Wireguard configuration of the worker
 * @param {string} params.workers_with_configs[].country_code - Country code of the worker
 * @param {string} params.workers_with_configs[].public_port - Public port of the worker
 * @param {string} params.workers_with_configs[].mining_pool_url - URL of the mining pool
 * @returns {Promise<Object>} Object with successes and failures arrays
 * @returns {Array} returns.successes - Array of successful worker tests
 * @returns {Array} returns.failures - Array of failed worker tests
 */
export async function validate_and_annotate_workers( { workers_with_configs=[] } ) {

    // If worker config list exceeds 250, warn this is close to ip subnet limit and might cause issues
    if( workers_with_configs.length > 250 ) {
        log.warn( `Worker config list exceeds 250, this may cause issues with IP subnet limits` )
    }

    if( CI_MODE === 'true' ) log.info( `Validating ${ workers_with_configs?.length } workers, first:`, workers_with_configs?.[0] )

    // Check that all workers are valid and have configs attached
    const [ valid_workers, invalid_workers ] = workers_with_configs.reduce( ( acc, worker ) => {

        const valid_worker = is_valid_worker( worker )
        const { wireguard_config } = worker
        const { config_valid, ...parsed_wg_config } = parse_wireguard_config( { wireguard_config } )
        const is_valid = valid_worker && config_valid

        if( !is_valid ) acc[1].push( { ...worker, ...parsed_wg_config, reason: `${ valid_worker ? 'valid' : 'invalid' } worker, ${ config_valid ? 'valid' : 'invalid' } wg config` } )
        else acc[0].push( { ...worker, ...parsed_wg_config } )

        return acc

    }, [ [], [] ] )

    // Score the selected workers
    const scoring_queue = valid_workers.map( async worker => {

        // Prepare test
        const start = Date.now()
        const test_result = { ...worker }

        try {
    
            // Start test
            const { json_config, text_config, mining_pool_url } = worker
            if( CI_MODE === 'true' ) log.info( `Validating worker ${ worker.ip } with config:`, worker )

            // Check that the worker is up to date
            const { version_valid, version } = await score_node_version( worker )
            if( !version_valid ) throw new Error( `Worker is running an outdated version: ${ version }` )

            // Check that the worker broadcasts mining pool membership
            await worker_matches_miner( { worker, mining_pool_url, throw_on_mismatch: true } )

            // Validate that wireguard config works
            const { valid, message } = await test_wireguard_connection( { wireguard_config: text_config } )
            if( !valid ) throw new Error( `Wireguard config invalid for ${ worker.ip }: ${ message }` )

            // Test the socks5 config works
            const { socks5_config: sock } = worker
            const socks5_valid = await test_socks5_connection( { sock } )
            if( !socks5_valid ) {
                log.warn( `Socks5 config invalid for ${ worker.ip }, this probably means you need to update your worker:`, worker )
                throw new Error( `Socks5 config invalid for ${ worker.ip }` )
            }

            // Get the most recent country data for these workers
            const { country_code, datacenter } = await ip_geodata( worker.ip )
            test_result.country_code = country_code
            test_result.datacenter = datacenter
    
            // Set test result
            test_result.success = true
            test_result.status = 'up'

        } catch ( e ) {
            log.info( `Error scoring worker ${ worker.ip }: ${ e.message }:`, e )
            test_result.success = false
            test_result.error = e.message
            test_result.status = 'down'
        } finally {
            test_result.test_duration_s = ( Date.now() - start ) / 1_000
        }
        log.debug( `Worker ${ worker.ip } test result:`, test_result )

        return test_result
    
    } )
    
    // Wait for all workers to be scored
    let workers_test_results = await Promise.allSettled( scoring_queue )
    const [ successes, failures ] = workers_test_results.reduce( ( acc, promise_test_result_obj ) => {
    
        const { status, value: test_result={}, reason } = promise_test_result_obj

        // 2 Failure cases exist, promise rejected, or promise fulfilled but success == false
        const promise_success = status === 'fulfilled'
        const test_success = test_result.success === true
        const overall_success = promise_success && test_success
        
        // On promise fail, annotate the result with the reason to match the test result structure. This should never happen given the use of try/catch/finally above
        if( !promise_success ) {
            test_result.error = ` - promise rejected, error: ${ reason }`
            test_result.success = false
        }

        if( overall_success ) acc[0].push( test_result )
        else acc[1].push( test_result )
    
        return acc
    }, [ [], [ ...invalid_workers ] ] )

    // Isolate the allSettled values for the workers with status
    const workers_with_status = workers_test_results.map( worker => worker?.value ).filter( worker => worker )

    return { successes, failures, workers_with_status }

}