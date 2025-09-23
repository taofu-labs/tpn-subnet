// Dependencies
import { cache, log, wait } from "mentie"

// Get relevant environment data
import { get_git_branch_and_hash, check_system_warnings, run } from './modules/system/shell.js'
import { run_mode } from "./modules/validations.js"
import { readFile } from 'fs/promises'
const { version } = JSON.parse( await readFile( new URL( './package.json', import.meta.url ) ) )
const { branch, hash } = await get_git_branch_and_hash()
const { CI_MODE, SERVER_PUBLIC_PORT=3000, CI_MOCK_MINING_POOL_RESPONSES } = process.env
const {  DAEMON_INTERVAL_SECONDS=CI_MODE === 'true' ? 60 : 300 } = process.env
const { mode, worker_mode, validator_mode, miner_mode } = run_mode()
const last_start = cache( 'last_start', new Date().toISOString() )
const intervals = []

/* ///////////////////////////////
// System setup
// /////////////////////////////*/

// Boot up message
log.info( `🚀  ${ last_start } - Starting TPN in ${ mode } mode. Version ${ version } (${ branch }/${ hash })` )

// Check system resources
await check_system_warnings()

// Initialize database
import { init_database } from './modules/database/init.js'
await init_database()

// Update geolocation databases
if( validator_mode || miner_mode ) {

    const { geolocation_update_interval_ms } = await import( './modules/geolocation/helpers.js' )
    const { update_maxmind } = await import( './modules/geolocation/maxmind.js' )
    const { update_ip2location_bin } = await import( './modules/geolocation/ip2location.js' )

    await Promise.allSettled( [
        update_maxmind(),
        update_ip2location_bin()
    ] )

    // On start, clear network
    const { clean_up_tpn_interfaces, clean_up_tpn_namespaces } = await import( "./modules/networking/wireguard.js" )
    await clean_up_tpn_interfaces()
    await clean_up_tpn_namespaces()

}

// Import express
import { app } from './modules/networking/server.js'
import { base_url } from "./modules/networking/url.js"

// Root route responds with identity
import { router as health_router } from './routes/health.js'
app.use( '/', health_router )

/* ///////////////////////////////
// Routes
// /////////////////////////////*/

// Protocol routes
if( validator_mode || miner_mode ) {

    const { router: protocol_router } =  await import( './routes/protocol/neurons.js' )
    const { router: stats_router } = await import( './routes/protocol/stats.js' )
    const { router: challenge_solution_router } = await import( './routes/protocol/challenge-response.js' )
    app.use( '/protocol', protocol_router )
    app.use( '/protocol', stats_router )
    app.use( '/protocol/challenge', challenge_solution_router )
    log.info( `/protocol/ routes registered` )

}

// Miner routes
if( miner_mode ) {
    const { router: miner_broadcast_router } = await import( './routes/miner/broadcast.js' )
    app.use( '/miner/broadcast', miner_broadcast_router )
}

// Validator routes
if( validator_mode ) {

    const { router: validator_broadcast_router } = await import( './routes/validator/broadcast.js' )
    const { router: validator_scoring } = await import( './routes/validator/score.js' )
    app.use( '/validator/broadcast', validator_broadcast_router )
    app.use( '/validator/score', validator_scoring )
    log.info( `/validator/ routes registered` )

}

// Worker routes
if( worker_mode ) {

    const { router: worker_register_router } = await import( './routes/worker/register.js' )
    app.use( '/worker/register', worker_register_router )
    if( CI_MODE === 'true' && CI_MOCK_MINING_POOL_RESPONSES === 'true' ) {
        log.info( `🤡 mocking [POST] /miner/broadcast/worker` )
        app.use( '/miner/broadcast', worker_register_router )
    }
    log.info( `/worker/ routes registered` )

}

// API Routes
import { router as api_status_router } from './routes/api/status.js'
import { router as api_lease_router } from './routes/api/lease.js'
app.use( '/api/', api_status_router )
app.use( '/api/', api_lease_router )
log.info( `/api/ routes registered` )

/* ///////////////////////////////
// Start server
// /////////////////////////////*/
log.info( `Starting server on :${ SERVER_PUBLIC_PORT }` )
const server = app.listen( SERVER_PUBLIC_PORT, () => {
    console.log( `Server running on :${ SERVER_PUBLIC_PORT }, serving from base url ${ base_url }` )
} )

// Handle graceful shutdown
import { handle_exit_gracefully } from './modules/system/process.js'
handle_exit_gracefully( server, intervals )

/* ///////////////////////////////
// Initialise Daemons
// /////////////////////////////*/

// Update geolocation databases
if( validator_mode || miner_mode ) {

    const { geolocation_update_interval_ms } = await import( './modules/geolocation/helpers.js' )
    const { update_maxmind } = await import( './modules/geolocation/maxmind.js' )
    const { update_ip2location_bin } = await import( './modules/geolocation/ip2location.js' )
    intervals.push( setInterval( update_maxmind, geolocation_update_interval_ms ) )
    intervals.push( setInterval( update_ip2location_bin, geolocation_update_interval_ms ) )
    log.info( `Geolocation databases updated and will be refreshed every ${ geolocation_update_interval_ms / 1000/ 60 / 60 } hours` )

}


// Register with mining pool
if( worker_mode && CI_MOCK_MINING_POOL_RESPONSES !== 'true' ) {
    const worker_update_interval = 60_000 * 60
    const { register_with_mining_pool } = await import( './modules/api/worker.js' )
    let success = false
    while( !success ) {
        const { registered } = await register_with_mining_pool()
        success = registered
        if( !success ) await wait( 5_000 )
    }
    intervals.push( setInterval( register_with_mining_pool, worker_update_interval ) )
}

// Initialise periodic daemons
if( miner_mode ) {
    const { score_all_known_workers } = await import( './modules/scoring/score_workers.js' )
    const { register_mining_pool_with_validators, register_mining_pool_workers_with_validators } = await import( './modules/api/mining_pool.js' )
    
    intervals.push( setInterval( register_mining_pool_with_validators, DAEMON_INTERVAL_SECONDS * 1_000 ) )
    intervals.push( setInterval( score_all_known_workers, DAEMON_INTERVAL_SECONDS * 1_000 ) )
    intervals.push( setInterval( register_mining_pool_workers_with_validators, DAEMON_INTERVAL_SECONDS * 1_000 ) )
    
    log.info( `🏴‍☠️  Scoring all known workers every ${ DAEMON_INTERVAL_SECONDS } seconds` )
    if( CI_MODE === 'true' ) {

        // Register with validator
        let success = false
        while( ! success ) {
            const { successes } = await register_mining_pool_with_validators()
            success = !!successes?.length
        }
        
        // One-time scoring for CI testing
        await wait( 30_000 )
        await score_all_known_workers()

        // Broadcast worker data to validators
        await register_mining_pool_workers_with_validators()

    }
}
if( validator_mode ) {
    const { score_mining_pools } = await import( './modules/scoring/score_mining_pools.js' )
    intervals.push( setInterval( score_mining_pools, DAEMON_INTERVAL_SECONDS * 1_000 ) )
    log.info( `🏴‍☠️  Scoring all known mining pools every ${ DAEMON_INTERVAL_SECONDS } seconds` )
    if( CI_MODE === 'true' ) {
        await wait( 60_000 )
        await score_mining_pools()
    }
}

// CI mode auto update codebase
if( CI_MODE === 'true' ) {
    log.warn( `💥 IMPORTANT: CI mode is triggering auto-updates, unless you work at Taofu you should NEVER EVER SEE THIS` )
    let interval = 1_000
    if( miner_mode ) interval += 5_000
    if( worker_mode ) interval += 10_000

    const pull = async () => {
        let { stderr, stdout, error } = await run( `git pull`, { silent: true } )
        while( !stdout?.includes( `Already up to date` ) && !stderr?.includes( `commit or stash` ) ) {
            log.info( `♻️ Pulled remote version` )
            await run( `npm i` ).catch( e => log.error( `Error installing dependencies: ${ e.message }` ) )
            await wait( interval );
            ( { stderr, stdout, error } = await run( `git pull`, { silent: true } ) )
            log.warn( `The process should have restarted by now, killing it manually` )
            process.exit( 1 )
        }
    }
    await pull()
    intervals.push( setInterval( pull, interval ) )
}
