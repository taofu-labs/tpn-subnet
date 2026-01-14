import { Router } from "express"
import { score_mining_pools } from "../../modules/scoring/score_mining_pools.js"
import { cache, log } from "mentie"
import { get_pool_scores } from "../../modules/database/mining_pools.js"
import { request_is_local } from "../../modules/networking/network.js"
import { get_workers } from "../../modules/database/workers.js"
import { get_config_directly_from_worker } from "../../modules/networking/worker.js"
import { parse_wireguard_config } from "../../modules/networking/wireguard.js"
import { validate_and_annotate_workers, worker_matches_miner } from "../../modules/scoring/score_workers.js"


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

        // Verify worker membership - skip workers that don't report correct mining pool
        await Promise.allSettled( workers.map( async ( worker, index ) => {
            const { mining_pool_url } = worker
            const is_member = await worker_matches_miner( { worker, mining_pool_url } )
            workers[ index ].is_member = is_member
        } ) )

        // Filter to only test members
        const member_workers = workers.filter( w => w.is_member )
        log.info( `${ member_workers.length }/${ workers.length } workers verified as members` )

        // Fetch wireguard and socks5 configs for each member worker
        await Promise.allSettled( member_workers.map( async ( worker, index ) => {
            const wireguard_config = await get_config_directly_from_worker( { worker } )
            const { text_config } = parse_wireguard_config( { wireguard_config } )
            if( text_config ) member_workers[ index ].wireguard_config = text_config

            const socks5_config = await get_config_directly_from_worker( { worker, type: 'socks5', format: 'text' } )
            if( socks5_config ) member_workers[ index ].socks5_config = socks5_config
        } ) )

        // Test all member workers
        const { successes, failures } = await validate_and_annotate_workers( { workers_with_configs: member_workers } )

        // Calculate uptime percentage based on verified members only
        const total = member_workers.length
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
