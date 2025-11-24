import { abort_controller, cache, log, round_number_to_decimals, shuffle_array, wait } from "mentie"
import { get_tpn_cache } from "../caching.js"
import { get_worker_countries_for_pool, get_workers, read_worker_broadcast_metadata, write_workers } from "../database/workers.js"
import { cochrane_sample_size } from "../math/samples.js"
import { validate_and_annotate_workers } from "./score_workers.js"
import { read_mining_pool_metadata, write_pool_score } from "../database/mining_pools.js"
import { get_miners, get_worker_config_through_mining_pool } from "../networking/miners.js"
const { CI_MODE, CI_MOCK_MINING_POOL_RESPONSES, CI_MOCK_WORKER_RESPONSES, CI_MINER_IP_OVERRIDES } = process.env

/**
 * Validator function to score mining pools based on worker performance
 * @returns {Object} results - Object containing the scores of each mining pool
 */
export async function score_mining_pools( max_duration_minutes=30 ) {

    try {


        // Set up a lock to prevent race conditions
        const lock = cache( `score_mining_pools_running` )
        if( lock ) return log.warn( `score_mining_pools is already running` )
        cache( `score_mining_pools_running`, true, max_duration_minutes * 60_000 )

        // Get mining pool uids and ips
        let mining_pool_uids = get_tpn_cache( 'miner_uids', [] )
        let attempts = 0

        // Wait for uids
        while( !mining_pool_uids?.length && attempts < 5 ) {
            log.info( `[ WHILE ] No mining pools found in cache, waiting 10 seconds and retrying...` )
            await wait( 10_000 )
            mining_pool_uids = get_tpn_cache( 'miner_uids', [] )
            attempts++
        }
        
        // Wait for ip data
        attempts = 0
        let miner_uid_to_ip = get_tpn_cache( 'miner_uid_to_ip', {} )
        while( !Object.keys( miner_uid_to_ip || {} )?.length && attempts < 5 ) {
            log.info( `[ WHILE ] No mining pool IPs found in cache, waiting 10 seconds and retrying...` )
            await wait( 10_000 )
            miner_uid_to_ip = get_tpn_cache( 'miner_uid_to_ip', {} )
            attempts++
        }
        log.info( `Found mining pools to score (${ mining_pool_uids.length }): `, mining_pool_uids )

        // If we are running in CI mode, add a the live testing mining pool if defined
        if( CI_MODE === 'true' ) {

            const override_ips = await get_miners( { overrides_only: true } )
            override_ips.forEach( ( { ip, uid } ) => {
                mining_pool_uids.push( uid )
                miner_uid_to_ip[ uid ] = ip
                log.info( `Added CI override mining pool ${ uid }@${ ip }` )
            } )

        }

        // Before scoring, filter out pools without metadata or workers
        const valid_mining_pool_uids = []
        for( const mining_pool_uid of mining_pool_uids ) {
            const mining_pool_ip = miner_uid_to_ip[ mining_pool_uid ]
            if( !mining_pool_ip ) {
                log.info( `No IP found for mining pool ${ mining_pool_uid }, skipping` )
                continue
            }
            const [ { updated }={} ]= await read_worker_broadcast_metadata( { mining_pool_uid, mining_pool_ip, limit: 1 } )
            if( !updated ) {
                log.info( `No worker broadcast metadata found for mining pool ${ mining_pool_uid }@${ mining_pool_ip }, skipping` )
                continue
            }
            const { success: workers_success, workers=[] } = await get_workers( { mining_pool_uid, limit: 1 } )
            if( !workers_success || !workers?.length ) {
                log.info( `No workers found for mining pool ${ mining_pool_uid }@${ mining_pool_ip }, skipping` )
                continue
            }
            valid_mining_pool_uids.push( mining_pool_uid )
        }
        log.info( `Filtered to ${ valid_mining_pool_uids.length } mining pools with workers and metadata` )

        // Fisher-Yates shuffle the miner uid array
        shuffle_array( valid_mining_pool_uids )
        log.info( `Shuffled ${ valid_mining_pool_uids.length } mining pools: `, valid_mining_pool_uids )


        // For each mining pool, run test
        const results = {}
        for( const mining_pool_uid of valid_mining_pool_uids ) {

            // Score the mining pool
            try {

                log.info( `Starting scoring for mining pool ${ mining_pool_uid }` )

                // Formulate pool label
                const mining_pool_ip = miner_uid_to_ip[ mining_pool_uid ]
                if( !mining_pool_ip ) {
                    log.info( `No IP found for mining pool ${ mining_pool_uid }, this should never happen` )
                    results[ mining_pool_uid ] = { mining_pool_ip, note: 'No IP found' }
                    continue
                }

                // Get mining pool scores
                const { score, stability_score, geo_score, size_score, performance_score } = await score_single_mining_pool( { mining_pool_uid, mining_pool_ip } )

                // Save mining pool score to database
                await write_pool_score( { mining_pool_ip, mining_pool_uid, stability_score, geo_score, size_score, performance_score, score } )

                // Write results
                results[ mining_pool_uid ] = { mining_pool_ip, score, stability_score, geo_score, size_score, performance_score }
                log.info( `Completed scoring for mining pool ${ mining_pool_uid } (${ score })` )


            } catch ( e ) {
                results[ mining_pool_uid ] = { error: e.message }
                log.info( `Error scoring mining pool ${ mining_pool_uid }:`, e.message )
            }

        }

        // Return results
        return results


    } catch ( e ) {
        log.error( `Error scoring mining pools:`, e )
    } finally {

        // Unlock
        cache( `score_mining_pools_running`, false )

    }

}

/**
 * Scores a single mining pool based on worker performance metrics.
 * @param {Object} params - Scoring parameters.
 * @param {string} params.mining_pool_uid - Unique identifier of the mining pool.
 * @param {string} params.mining_pool_ip - IP address of the mining pool.
 * @returns {Promise<{size_score: number, stability_score: number, performance_score: number, geo_score: number, score: number}>} - Scoring metrics for the pool.
 */
async function score_single_mining_pool( { mining_pool_uid, mining_pool_ip } ) {

    // Prepare for scoring
    const pool_label = `${ mining_pool_uid }@${ mining_pool_ip }`
    log.info( `Scoring mining pool ${ pool_label }` )

    // Get the latest broadcast metadata of the worker data
    const [ { last_known_worker_pool_size, updated }={} ]= await read_worker_broadcast_metadata( { mining_pool_uid, mining_pool_ip, limit: 1 } )
    if( !updated ) throw new Error( `No worker broadcast metadata found for mining pool ${ mining_pool_uid }@${ mining_pool_ip }` )

    // Grab the latest workers
    const { success: workers_success, workers } = await get_workers( { mining_pool_uid, limit: last_known_worker_pool_size, status: 'up' } )
    if( !workers_success ) throw new Error( `No workers found for mining pool ${ mining_pool_uid }@${ mining_pool_ip }` )

    // Calculate sample size to use
    const sample_size = cochrane_sample_size( { node_count: workers.length } )

    // Select random workers of sample size
    const selected_workers = sample_size >= workers.length ? workers : []
    if( selected_workers.length == 0 ) while( selected_workers.length < sample_size ) {
        const random_worker = workers[ Math.floor( Math.random() * workers.length ) ]
        if( !selected_workers.includes( random_worker ) ) {
            selected_workers.push( random_worker )
        }
    }
    log.info( `Selected ${ selected_workers.length } workers for scoring from mining pool ${ pool_label }` )

    // Annotate the selected workers with a wireguard config for testing in paralell
    await Promise.allSettled( selected_workers.map( async ( worker, index ) => {
        const text_config = await get_worker_config_through_mining_pool( { worker, mining_pool_uid, mining_pool_ip, format: 'text', lease_seconds: 120 } )
        if( text_config ) selected_workers[ index ].wireguard_config = text_config
        if( !text_config ) log.info( `Error fetching worker config for ${ worker.ip }` )
    } ) )

    // Score the selected workers
    const { successes, failures, workers_with_status } = await validate_and_annotate_workers( { workers_with_configs: selected_workers } )
    log.info( `Scored workers for mining pool ${ pool_label }, successes: ${ successes?.length }, failures: ${ failures?.length }. Status annotated: ${ workers_with_status?.length }` )
    log.debug( `Failure exerpt: `, failures?.slice( 0, 3 ) )

    // Save updated worker data to database
    await write_workers( { workers: workers_with_status, mining_pool_uid, mining_pool_ip } )

    // Get the context needed to calculate scores
    const countries_in_pool = await get_worker_countries_for_pool( { mining_pool_uid, mining_pool_ip } )

    // Calculate stability score (up fraction)
    const stability_fraction = successes.length / selected_workers.length
    const stability_score = stability_fraction * 100

    // Calculate size score, defined as the ranking of the size against the last_known_worker_pool_size 
    const size_score = last_known_worker_pool_size * stability_fraction

    // Calculate performance score
    const no_response_penalty_s = 60
    const mean_test_length_s = successes.reduce( ( acc, worker_test ) => {
        let { ip, test_duration_s, error } = worker_test || {}
        if( !test_duration_s ) {
            log.warn( `No test duration for a successful worker ${ ip } in pool ${ pool_label }, err:`, error )
            test_duration_s = no_response_penalty_s
        }
        const incremented_acc = acc + test_duration_s
        if( isNaN( incremented_acc ) ) {
            log.warn( `NaN encountered when calculating mean test length for pool ${ pool_label }:`, { acc, test_duration_s, worker_test } )
            return acc
        }
        return incremented_acc
    }, 0 ) / successes.length

    // Calculate median test length by grabbing the middle value if odd, or averaging the two
    const middle_values = successes.map( w => w.test_duration_s || no_response_penalty_s ).sort( ( a, b ) => a - b ).slice( Math.floor( ( successes.length - 1 ) / 2 ), Math.ceil( ( successes.length + 1 ) / 2 ) )
    let median_test_length_s = middle_values.reduce( ( acc, val ) => acc + val, 0 ) / middle_values.length
    log.info( `Mean test length for ${ pool_label } ${ mean_test_length_s } based on ${ successes.length } tests and ${ middle_values.length } values` )
    log.info( `Median test length for ${ pool_label } ${ median_test_length_s } based on ${ successes.length } tests` )
    const s_considered_good = 10
    const performance_score = Math.min( 100 / ( median_test_length_s / s_considered_good ), 100 )
    const performance_fraction = performance_score / 100

    // Calculate the geographic score
    const unique_countries = await get_worker_countries_for_pool()
    log.debug( `Unique countries across all pools: `, unique_countries )
    if( !unique_countries?.length ) throw new Error( `No unique countries found across all pools, cannot calculate geo score` )
    const total_countries = unique_countries.length
    const geo_completeness_fraction = round_number_to_decimals( countries_in_pool.length / total_countries, 4 )
    const geo_score = round_number_to_decimals( geo_completeness_fraction * 100, 2 )
    log.info( `Geo completeness for mining pool ${ pool_label }: ${ countries_in_pool.length } unique countries out of ${ total_countries }, geo_score: ${ geo_score }` )

    // Calculate the composite score
    log.info( `Scoring inputs for ${ pool_label }: `, { size_score, stability_score, stability_fraction, performance_score, performance_fraction, geo_score, geo_completeness_fraction, total_countries } )
    const score = size_score * performance_fraction * Math.sqrt( geo_completeness_fraction ) * stability_fraction
    log.info( `Final score for mining pool ${ pool_label }: ${ score }` )
    const composite_scores = {
        size_score: round_number_to_decimals( size_score ),
        stability_score: round_number_to_decimals( stability_score ),
        performance_score: round_number_to_decimals( performance_score ),
        geo_score: round_number_to_decimals( geo_score ),
        score: round_number_to_decimals( score )
    }

    // Send feedback to the mining pool
    try {
        const feedback = { composite_scores, workers_with_status }
        const { fetch_options } = abort_controller( { timeout_ms: 5_000 } )
        const { protocol, url, port } = await read_mining_pool_metadata( { mining_pool_ip, mining_pool_uid } )
        if( !url?.includes( port ) || !url?.includes( protocol ) ) log.warn( `Mining pool URL ${ url } does not include port ${ port } or protocol ${ protocol }, this suggests misconfiguration of the miner` )
        const endpoint = `${ url }/miner/broadcast/worker/feedback`
        log.info( `Sending feedback to mining pool ${ pool_label } at endpoint ${ endpoint }` )
        const { success } = await fetch( endpoint, { ...fetch_options, method: 'POST', body: JSON.stringify( feedback ), headers: { 'Content-Type': 'application/json' } } )
        log.info( `Feedback sent to mining pool ${ pool_label }, pool reported success: ${ success }` )
        if( !success ) throw new Error( `Failed to send feedback to mining pool ${ pool_label } for unknown reason` )

    } catch ( e ) {
        log.warn( `Error sending feedback to mining pool ${ pool_label }:`, e.message )
    }

    // Return the scores
    return composite_scores

}

