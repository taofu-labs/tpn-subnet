import { Router } from "express"
import { score_mining_pools } from "../../modules/scoring/score_mining_pools.js"
import { cache, log } from "mentie"
import { get_pool_scores } from "../../modules/database/mining_pools.js"
import { request_is_local } from "../../modules/networking/network.js"
import { get_workers } from "../../modules/database/workers.js"
import { parse_wireguard_config } from "../../modules/networking/wireguard.js"
import { validate_and_annotate_workers, match_worker_to_pool } from "../../modules/scoring/score_workers.js"
import { get_worker_config_as_validator } from "../../modules/api/validator.js"
import { get_tpn_cache } from "../../modules/caching.js"
import { is_partnered_pool } from "../../modules/partnered_pools.js"


export const router = Router()

router.get( "/force", async ( req, res ) => {

    // Endpoint may only be called is CI_MODE is on
    const { CI_MODE, CI_MOCK_WORKER_RESPONSES, CI_MOCK_MINING_POOL_RESPONSES } = process.env
    log.info( `Received force request`, { CI_MODE, CI_MOCK_WORKER_RESPONSES, CI_MOCK_MINING_POOL_RESPONSES } )
    if( CI_MODE !== 'true' ) {
        return res.status( 403 ).json( { error: "CI_MODE is not enabled" } )
    }

    // Force score all mining pools
    log.info( `Forcing scoring for validator` )
    const results = await score_mining_pools()
    log.info( `Completed forced scoring for validator`, results )
    return res.json( results )

} )

router.get( '/mining_pools', async ( req, res ) => {

    // Exit if not local request
    if( !request_is_local( req ) ) return res.status( 403 ).json( { error: `This endpoint may only be called from localhost` } )
    log.info( `Received request for mining pool scores` )

    try { 
        // Check for cached value
        const cached_scores = cache( 'mining_pool_scores' )
        if( cached_scores ) return res.json( cached_scores )

        // Get updated scores
        const { success, message, scores } = await get_pool_scores()
        if( !success ) throw new Error( `Failed to get scores from database: ${ message }` )
        log.info( `Fetched ${ scores?.length } scores` )

        // Formulate scores as key value
        const scores_by_pool = scores.reduce( ( acc, { mining_pool_uid, ...rest } ) => {
            acc[ mining_pool_uid ] = rest
            return acc
        }, {} )

        // Cache and return scores
        cache( 'mining_pool_scores', scores_by_pool, 5_000 )
        return res.json( scores_by_pool )

    } catch ( e ) {
        log.error( `Error fetching mining pool scores:`, e )
        return res.status( 500 ).json( { error: e.message } )
    }

} )

/**
 * Audit endpoint that tests all workers in a pool and returns their status.
 * Requires ADMIN_API_KEY to be set in environment and matching api_key query parameter.
 *
 * @example
 * curl --max-time 0 "http://localhost:3000/validator/score/audit/pool123?api_key=your_admin_key"
 */
router.get( '/audit/:pool_uid', async ( req, res ) => {

    const { api_key } = req.query
    const { pool_uid } = req.params

    // Check ADMIN_API_KEY is configured and matches the provided key
    const { ADMIN_API_KEY } = process.env
    if( !ADMIN_API_KEY ) return res.status( 403 ).json( { error: `ADMIN_API_KEY not configured` } )
    if( api_key !== ADMIN_API_KEY ) return res.status( 403 ).json( { error: `Invalid API key` } )

    // Prevent concurrent audits for the same pool
    const lock_key = `audit_pool_${ pool_uid }_running`
    const locked = cache( lock_key )
    if( locked ) return res.status( 429 ).json( { error: `Audit already in progress for pool ${ pool_uid }` } )

    try {

        // Set lock for 15 minutes max duration
        cache( lock_key, true, 15 * 60_000 )

        log.info( `Starting audit for pool ${ pool_uid }` )

        // Get workers for this pool
        const { workers } = await get_workers( { mining_pool_uid: pool_uid } )
        if( !workers?.length ) return res.json( { worker_up_percentage: 0, workers: {} } )

        log.info( `Auditing ${ workers.length } workers for pool ${ pool_uid }` )

        // Resolve mining pool IP for partnered pool check
        const miner_uid_to_ip = get_tpn_cache( 'miner_uid_to_ip', {} )
        const mining_pool_ip = miner_uid_to_ip[ pool_uid ]
        const partnered = mining_pool_ip && is_partnered_pool( { mining_pool_uid: pool_uid, mining_pool_ip } )

        // For partnered pools, workers can't be called directly — skip membership check, treat all as members
        let workers_to_validate = workers
        if( !partnered ) {

            // Verify worker membership - skip workers that don't report correct mining pool
            await Promise.allSettled( workers.map( async ( worker, index ) => {
                const { mining_pool_url } = worker
                const { matches } = await match_worker_to_pool( { worker, mining_pool_url } )
                workers[ index ].is_member = matches
            } ) )

            // Filter to only test members
            workers_to_validate = workers.filter( w => w.is_member )
            log.info( `${ workers_to_validate.length }/${ workers.length } workers verified as members` )

        } else {
            log.info( `Pool ${ pool_uid } is a partnered network pool, skipping membership check` )
            workers.forEach( w => w.is_member = true )
        }

        // Fetch wireguard and socks5 configs for each worker to validate
        await Promise.allSettled( workers_to_validate.map( async ( worker, index ) => {
            log.debug( `Fetching audit configs for worker ${ worker.ip }` )
            // Pin selection to this specific worker by geo and whitelist
            const audit_params = { geo: worker.country_code, whitelist: [ worker.ip ], lease_seconds: 60 }

            const wireguard_result = await get_worker_config_as_validator( audit_params )
            const wireguard_config = wireguard_result?._lease_result ? wireguard_result.config : wireguard_result
            const { text_config } = parse_wireguard_config( { wireguard_config } )
            log.insane( `Parsed wireguard config for worker ${ worker.ip }:`, wireguard_config )
            if( text_config ) workers_to_validate[ index ].wireguard_config = text_config

            log.debug( `Fetching socks5 config for worker ${ worker.ip }` )
            const socks5_result = await get_worker_config_as_validator( { ...audit_params, type: 'socks5', format: 'text' } )
            const socks5_config = socks5_result?._lease_result ? socks5_result.config : socks5_result
            if( socks5_config ) workers_to_validate[ index ].socks5_config = socks5_config
            log.insane( `Parsed socks5 config for worker ${ worker.ip }:`, socks5_config )
        } ) )

        // Test all workers (partnered pools skip version + membership checks in validate_and_annotate_workers)
        const { successes, failures } = await validate_and_annotate_workers( { workers_with_configs: workers_to_validate, mining_pool_uid: pool_uid, mining_pool_ip } )

        // Calculate uptime percentage based on verified members only
        const total = workers_to_validate.length
        const up_count = successes.length
        const worker_up_percentage = total > 0 ?  up_count / total  * 100 : 0

        // Build workers object with IP as key
        const all_tested = [ ...successes, ...failures ]
        const non_members = workers.filter( w => !w.is_member )

        const tested_results = all_tested.reduce( ( acc, worker ) => {
            acc[ worker.ip ] = { ...worker, verified: worker.success === true }
            return acc
        }, {} )

        const non_member_results = non_members.reduce( ( acc, worker ) => {
            acc[ worker.ip ] = { ...worker, verified: false }
            return acc
        }, {} )

        // Merge tested and non-member results
        const workers_result = { ...tested_results, ...non_member_results }

        log.info( `Audit completed for pool ${ pool_uid }: ${ up_count }/${ total } workers up (${ worker_up_percentage.toFixed( 2 ) }%)` )

        return res.json( {
            worker_up_percentage,
            workers: workers_result
        } )

    } catch ( e ) {
        log.error( `Error auditing pool ${ pool_uid }:`, e )
        return res.status( 500 ).json( { error: e.message } )
    } finally {

        // Release lock
        cache( lock_key, false )

    }

} )
