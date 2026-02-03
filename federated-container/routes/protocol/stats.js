import { Router } from "express"
import { get_complete_tpn_cache, get_tpn_cache } from "../../modules/caching.js"
import { get_pool_scores, read_mining_pool_metadata } from "../../modules/database/mining_pools.js"
import { abort_controller, cache, log } from "mentie"
import { get_worker_countries_for_pool, get_workers, read_worker_broadcast_metadata } from "../../modules/database/workers.js"
import { is_validator_request } from "../../modules/networking/validators.js"
const { ADMIN_API_KEY } = process.env

export const router = Router()

/**
 * Route to handle stats submitted from the neuron
 */
router.get( "/stats", async ( req, res ) => {

    const { api_key  } = req.query || {}

    // Check if request came from validator
    const is_validator = await is_validator_request( req )
    const is_authenticated = ADMIN_API_KEY && api_key === ADMIN_API_KEY

    // Validate api key
    if( !is_validator && !is_authenticated ) {
        log.info( `Unauthorized stats request denied` )
        return res.status( 401 ).json( { error: 'Unauthorized: invalid API key or not from validator' } )
    }

    // Get tpn cache
    const tpn_cache = get_complete_tpn_cache()

    return res.json( tpn_cache )

} )

router.get( "/stats/pools", async ( req, res ) => {

    try {

        // Check for caches value
        const cached_pool_data = cache( 'protocol_stats_pools' )
        if( cached_pool_data ) {
            log.info( `Returning cached protocol stats pools data` )
            return res.json( cached_pool_data )
        }

        // Get pool metadata
        const miner_uid_to_ip = get_tpn_cache( 'miner_uid_to_ip', {} )
        let { pools: pools_metadata  } = await read_mining_pool_metadata( { limit: null } )
        log.info( `Fetched metadata for ${ pools_metadata?.length || 0 } mining pools from database` )
        pools_metadata = pools_metadata.filter( ( { mining_pool_ip, mining_pool_uid }  ) => {
            const expected_ip = miner_uid_to_ip?.[ mining_pool_uid ]
            if( expected_ip === undefined ) {
                log.debug( `Excluding mining pool ${ mining_pool_uid } with IP ${ mining_pool_ip }: not found in miner_uid_to_ip cache` )
                return false
            }
            return mining_pool_ip === expected_ip
        }  )
        log.info( `Filtered metadata to ${ pools_metadata?.length || 0 } mining pools` )
        log.debug( `Pools metadata example: `, pools_metadata[0] )

        // Sort pools_metadata by mining_pool_uid ascending
        pools_metadata = pools_metadata.map( ( { mining_pool_uid, ...pool } ) => ( { mining_pool_uid: Number( mining_pool_uid ), ...pool } ) )
        pools_metadata.sort( ( a, b ) => a.mining_pool_uid - b.mining_pool_uid )

        // Get mining pool scores and create lookup map for O(1) access
        const { scores: mining_pool_scores } = await get_pool_scores()
        const scores_by_uid = new Map( mining_pool_scores?.map( s => [ s.mining_pool_uid, s ] ) )
        log.info( `Fetched scores for ${ mining_pool_scores?.length || 0 } mining pools from database` )
        log.debug( `Mining pool scores example: `, mining_pool_scores[0] )

        // Collate data by mining pool uid
        const pools = await Promise.all( pools_metadata?.map( async pool => {

            // Get validator level data
            const { mining_pool_uid, url } = pool || {}
            const { score, stability_score, size_score, performance_score, geo_score } = scores_by_uid.get( mining_pool_uid ) || {}

            // Get worker countries for this pool
            const countries = await get_worker_countries_for_pool( { mining_pool_uid } )

            // Get pool metadata
            const [ { last_known_worker_pool_size }={} ] = await read_worker_broadcast_metadata( { mining_pool_uid } )

            // Get pool broadcast data
            const { fetch_options } = abort_controller( { timeout_ms: 1_000 } )
            const { version, MINING_POOL_REWARDS, MINING_POOL_WEBSITE_URL } = await fetch( url, fetch_options ).then( res => res.json() ).catch( e => ( { error: e.message } ) )

            const data = {
                mining_pool_uid,
                url,
                score,
                stability_score,
                size_score,
                performance_score,
                geo_score,
                version,
                MINING_POOL_REWARDS,
                MINING_POOL_WEBSITE_URL,
                countries,
                last_known_worker_pool_size
            }

            // Return data for this pool
            return data

        }  ) )

        // Cache the full pools array
        const cache_minutes = 10
        cache( 'protocol_stats_pools', pools, cache_minutes * 60_000 )

        // Return pools data
        return res.json( pools )


    } catch ( e ) {
        return res.status( 500 ).json( { error: e.message } )
    }

} )

router.get( "/stats/workers", async ( req, res ) => {
    
    try {

        // Check for caches value
        const cached_worker_data = cache( 'protocol_stats_workers' )
        if( cached_worker_data ) {
            log.info( `Returning cached protocol stats workers data` )
            return res.json( cached_worker_data )
        }

        // Get all up workers
        const start = Date.now()
        const { workers } = await get_workers( { status: 'up', limit: null } )
        log.info( `Fetched ${ workers?.length || 0 } up workers from database` )
        log.debug( `Workers example: `, workers[0] )

        // Generate worker stats
        const { total, residential, datacenter, countries } = workers.reduce( ( acc, { connection_type, country } ) => {

            // Accumulate counts
            acc.total++
            if( connection_type === 'residential' ) acc.residential++
            if( connection_type === 'datacenter' ) acc.datacenter++

            // If no countries, no need to parse countries
            if( !country ) return acc

            // Initialize country object if not present
            if( !acc.countries_with_counts[ country ] ) acc.countries_with_counts[ country ] = { total: 0, residential: 0, datacenter: 0, unknown: 0 }

            // Accumulate country total counts
            acc.countries_with_counts[ country ].total++
            if( connection_type === 'residential' ) acc.countries_with_counts[ country ].residential++
            if( connection_type === 'datacenter' ) acc.countries_with_counts[ country ].datacenter++
            if( ![ 'residential', 'datacenter' ].includes( connection_type ) ) acc.countries_with_counts[ country ].unknown++

            // Add to counts_with_countries using persistent Sets
            acc.counts_with_countries.total.add( country )
            if( connection_type === 'residential' ) acc.counts_with_countries.residential.add( country )
            if( connection_type === 'datacenter' ) acc.counts_with_countries.datacenter.add( country )
            if( ![ 'residential', 'datacenter' ].includes( connection_type ) ) acc.counts_with_countries.unknown.add( country )

            return acc

        }, { total: 0, residential: 0, datacenter: 0, countries_with_counts: {}, counts_with_countries: { total: new Set(), residential: new Set(), datacenter: new Set(), unknown: new Set() } } )

        // Convert Sets to arrays for JSON serialization
        countries.counts_with_countries = {
            total: [ ...countries.counts_with_countries.total ],
            residential: [ ...countries.counts_with_countries.residential ],
            datacenter: [ ...countries.counts_with_countries.datacenter ],
            unknown: [ ...countries.counts_with_countries.unknown ]
        }

        // Cache the worker stats
        const cache_minutes = 10
        cache( 'protocol_stats_workers', { total, residential, datacenter, countries }, cache_minutes * 60_000 )
        
        // Log timing
        const duration = Date.now() - start
        log.info( `Generated protocol stats workers data in ${ duration } ms` )

        // Return worker stats
        return res.json( {
            total,
            residential,
            datacenter,
            countries
        } )

    } catch ( e ) {
        return res.status( 500 ).json( { error: e.message } )
    }

} )