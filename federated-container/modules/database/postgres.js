import postgres from 'pg'
import { default as _format } from 'pg-format'
import { log, wait } from 'mentie'
import { run } from '../system/shell.js'

// Create a connection pool to the postgres container
const { POSTGRES_PASSWORD='setthispasswordinthedotenvfile', POSTGRES_HOST='postgres', POSTGRES_PORT=5432, POSTGRES_USER='postgres', POSTGRES_DB='postgres', CI_MODE, RUN_MODE } = process.env
const { Pool } = postgres
log.info( `Connecting to postgres at ${ POSTGRES_USER }@${ POSTGRES_HOST }:${ POSTGRES_PORT } -p ${ POSTGRES_PASSWORD }` )
let _pool


/**
 * Wake up Postgres by ensuring a running container (in CI mode) and creating a PostgreSQL connection pool.
 * @async
 * @returns {Promise<Pool>} A promise that resolves to the Postgres connection pool.
 * @throws {Error} If the connection pool cannot be created after multiple attempts.
 */
export async function get_pg_pool() {

    // If we are in CI mode, spin up a postgres container if it is not already running
    if( CI_MODE ) {
        log.info( `CI mode detected, checking if postgres container is running` )
        const container_name = `tpn_ci_postgres`
        const first_boot = !_pool
        try {

            // Check if docker is running
            let { stdout: docker_info } = await run( `docker info`, { timeout_ms: 0 } )
            while( docker_info?.includes( 'Cannot connect to the Docker daemon' ) ) {
                log.info( `Waiting for Docker to start...` )
                await run( `open --hide --background -a Docker`, { timeout_ms: 0 } )
                await wait( 10_000 )
                const { stdout } = await run( `docker info`, { timeout_ms: 0 } )
                docker_info = stdout
            }

            // Check if the container is running
            const { stdout } = await run( `docker ps`, { timeout_ms: 0 } )
            const is_running = stdout?.includes( container_name )

            // If running, and this is the first boot, refresh the container
            if( !is_running ) {
                // if( first_boot ) {
                //     log.info( `🗑️ Postgres container is running, recreating it to clear out old data` )
                //     await run( `docker stop ${ container_name  }` )
                // }
                log.info( `Postgres container not running, starting it up` )
                await run( `docker run -d --rm --name ${ container_name } \\
                            -e POSTGRES_USER=${ POSTGRES_USER } \\
                            -e POSTGRES_PASSWORD=${ POSTGRES_PASSWORD } \\
                            -e POSTGRES_DB=${ POSTGRES_DB } \\
                            --health-cmd="pg_isready -U ${ POSTGRES_USER }" \\
                            --health-interval=10s \\
                            --health-timeout=5s \\
                            --health-retries=5 \\
                            -p ${ POSTGRES_PORT }:5432 postgres:latest`, { verbose: true, timeout_ms: 0 } )
            }
            let is_healthy = false
            while( !is_healthy ) {
                const { stdout } = await run( `docker inspect --format='{{json .State.Health.Status}}' ${ container_name }`, { timeout_ms: 0 } )
                is_healthy = stdout?.includes( 'healthy' )
                if( !is_healthy ) {
                    log.info( `Waiting for Postgres container to become healthy...` )
                    await wait( 5000 )
                }
            }
        } catch ( e ) {
            log.error( `Error checking or starting postgres container:`, e )
            throw new Error( `Failed to ensure Postgres container is running: ${ e.message }` )
        }
    }


    // Pool creation
    let attempts = 0
    while( attempts < 5 && ! _pool ) {
        try {
            log.info( `Creating Postgres pool` )
            _pool = new Pool( {
                user: POSTGRES_USER,
                host: POSTGRES_HOST,
                database: POSTGRES_DB,
                password: POSTGRES_PASSWORD,
                port: POSTGRES_PORT
            } )
        } catch ( e ) {
            attempts++
            log.error( `Error creating Postgres pool (attempt ${ attempts }):`, e )
            await wait( 5000 )
        }
    }

    if( ! _pool ) {
        throw new Error( `Failed to create Postgres pool after ${ attempts } attempts` )
    }

    return _pool

}

// Helper function to close the pool
export const close_pool = async () => _pool?.end?.().catch( e => log.error( 'Error closing Postgres pool:', e ) )

/**
 * Format a query using node-pg-format
 * @param {string} query - The SQL query string with placeholders, see https://www.npmjs.com/package/pg-format
 * @param {Array} values - The values to format into the query
 * @returns {string} The formatted query string
 * @throws {Error} If there is an error formatting the query
*/
export const format = ( query, values ) => {
    log.debug( `Formatting query:`, query, `with ${ values.length } values` )
    try {
        const formatted = _format( query, values )
        return formatted
    } catch ( e ) {
        log.error( `Error formatting query:`, {
            e,
            query,
            values: values.length
        } )
        throw new Error( `Failed to format query: ${ e.message }` )
    }
}