import { cache, log } from "mentie"
import { close_pool } from "../database/postgres.js"

/**
 * Sets up graceful shutdown handlers for the server.
 * @param {Object} server - The HTTP/HTTPS server instance.
 * @param {Array} [intervals] - Array of interval IDs to clear on shutdown.
 */
export function handle_exit_gracefully( server, intervals ) {

    const handle_close = async reason => {
        log.info( '⏻ Closing server, reason: ', reason || 'unknown' )
        log.info( '⏻ Shutting down gracefully...' )
        cache.clear( { i_am_sure: true } )
        log.info( '⏻ Cleared cache' )
        if( intervals?.length ) {
            intervals.forEach( clearInterval )
            log.info( `⏻ Cleared ${ intervals.length } intervals` )
        }
        server.close()
        log.info( '⏻ Closed server' )
        await close_pool()
        log.info( '⏻ Closed database connections' )
        process.exit( 0 )
    }

    // Handle shutdown signals
    const shutdown_signals = [ 'SIGTERM', 'SIGINT', 'SIGQUIT' ]
    shutdown_signals.map( signal => {
        log.info( `Listening for ${ signal } signal to shut down gracefully...` )
        process.on( signal, async () => handle_close( signal ) )
    } )

    // Handle uncaught exceptions
    process.on( 'uncaughtException', async ( err ) => {
        const now = new Date().toISOString()
        log.error( `${ now } - Uncaught exception:`, err.message, err.stack )
        await handle_close( 'uncaughtException' )
    } )
    process.on( 'unhandledRejection', async ( reason, promise ) => {
        const now = new Date().toISOString()
        log.error( `${ now } - Unhandled rejection at:`, promise, 'reason:', reason )
        await handle_close( 'unhandledRejection' )
    } )

}