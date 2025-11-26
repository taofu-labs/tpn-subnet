import { log, sanetise_string } from "mentie"
import { get_pg_pool, format } from "./postgres.js"
import { annotate_worker_with_defaults, is_valid_worker, sanetise_worker } from "../validations.js"
const { CI_MODE } = process.env

/**
 * Write an array of worker objects to the WORKERS table, where the composite primary key is (mining_pool_uid, mining_pool_ip, ip), and the entry is updated if it already exists.
 * @param {Array<{ ip: string, country_code: string, status?: string }>} workers - Array of worker objects with properties: ip, country_code
 * @param {string} mining_pool_uid - Unique identifier of the mining pool submitting the workers, used only for metadata broadcast
 * @param {boolean} is_miner_broadcast - broadcasts update mining pool worker metadata based on the worker array, only set if worker array is full worker list from mining pool
 * @returns {Promise<{ success: boolean, count: number, broadcast_metadata?: Object }> } - Result object with success status and number of entries written
 * @throws {Error} - If there is an error writing to the database
 */
export async function write_workers( { workers, mining_pool_uid='internal', is_miner_broadcast=false } ) {

    // Get the postgres pool
    const pool = await get_pg_pool()

    // Annotate workers with defaults and sanetise
    workers = workers.map( annotate_worker_with_defaults ).map( sanetise_worker )

    // Validate input
    const [ valid_workers, invalid_workers ] = workers.reduce( ( acc, worker ) => {
        if( is_valid_worker( worker ) ) acc[0].push( worker )
        else acc[1].push( worker )
        return acc
    }, [ [], [] ] )
    if( invalid_workers.length > 0 ) log.warn( `Invalid worker entries found:`, invalid_workers )
    if( valid_workers.length === 0 ) return { success: true, count: 0 }

    // Prepare the query with pg-format
    const values = valid_workers.map( ( { ip, country_code, mining_pool_url, public_url, payment_address_evm, payment_address_bittensor, public_port=3000, status='unknown', connection_type='unknown' } ) => [
        ip,
        public_port,
        public_url,
        payment_address_evm,
        payment_address_bittensor,
        country_code,
        mining_pool_url,
        mining_pool_uid,
        status,
        connection_type,
        Date.now()
    ] )
    const query = format( `
        INSERT INTO workers (ip, public_port, public_url, payment_address_evm, payment_address_bittensor, country_code, mining_pool_url, mining_pool_uid, status, connection_type, updated_at)
        VALUES %L
        ON CONFLICT (mining_pool_uid, mining_pool_url, ip) DO UPDATE SET
            ip = EXCLUDED.ip,
            public_port = EXCLUDED.public_port,
            public_url = EXCLUDED.public_url,
            payment_address_evm = EXCLUDED.payment_address_evm,
            payment_address_bittensor = EXCLUDED.payment_address_bittensor,
            country_code = EXCLUDED.country_code,
            mining_pool_url = EXCLUDED.mining_pool_url,
            mining_pool_uid = EXCLUDED.mining_pool_uid,
            status = EXCLUDED.status,
            connection_type = EXCLUDED.connection_type,
            updated_at = EXCLUDED.updated_at
    `, values )

    if( CI_MODE === 'true' ) log.info( `Valid worker example:`, values[0] )

    // Execute the query
    try {
        
        // Writing workers to db
        const worker_write_result = await pool.query( query )
        const broadcast_metadata = is_miner_broadcast ? await write_worker_broadcast_metadata( { mining_pool_uid, workers: valid_workers } ) : null
        log.info( `Wrote ${ worker_write_result.rowCount } workers to database${ is_miner_broadcast ? ' through miner broadcast ' : ''  }for mining pool ${ mining_pool_uid } ${ broadcast_metadata ? 'with broadcast metadata: ' : '' }`, broadcast_metadata ? broadcast_metadata : '' )
        
        // Mark workers not in this broadcast as stale
        if( is_miner_broadcast ) await mark_workers_stale( { mining_pool_uid, active_workers: valid_workers } )
        
        return { success: true, count: worker_write_result.rowCount, broadcast_metadata }
    } catch ( e ) {
        throw new Error( `Error writing workers to database: ${ e.message }` )
    }
}

/**
 * 
 * @param {Object} params 
 * @param {Array<{ip: string, status: string }>} params.workers - array with worker data
 * @returns {Promise<{ success: boolean, count: number }>} - Result object with success status and number of entries written
 * @throws {Error} - If there is an error writing to the database
 */
export async function write_worker_performance( { workers }  ) {

    // Get the postgres pool
    const pool = await get_pg_pool()

    // Validate input
    const [ valid_workers, invalid_workers ] = workers.reduce( ( acc, worker ) => {
        if( is_valid_worker( worker ) ) acc[0].push( worker )
        else acc[1].push( worker )
        return acc
    }, [ [], [] ] )
    if( invalid_workers.length > 0 ) log.warn( `Invalid worker entries found:`, invalid_workers )
    if( valid_workers.length === 0 ) return { success: true, count: 0 }

    // Prepare the query with pg-format

    // Write a new entry with the current ip, status, and timestamp
    const values = valid_workers.map( ( { ip, status='unknown', public_port } ) => [ ip, status, `http://${ ip }:${ public_port }`, Date.now() ] )
    const query = format( `
        INSERT INTO worker_performance (ip, status, public_url, updated_at)
        VALUES %L
    `, values )
        
    if( CI_MODE === 'true' ) log.info( `Valid worker example:`, valid_workers[0] )

    // Execute the query
    try {
        
        // Writing workers to db
        const worker_write_result = await pool.query( query )
        log.info( `Wrote ${ worker_write_result.rowCount } worker performance entries to database` )
        
        return { success: true, count: worker_write_result.rowCount }
    } catch ( e ) {
        throw new Error( `Error writing worker performance to database: ${ e.message }` )
    }

}

/**  
 * Fetches the worker performance entries from the database within the specified time range.
 * @param {Object} params - Query parameters.
 * @param {number} params.to - Upper time boundary (timestamp in milliseconds). Defaults to current time.
 * @param {number} params.from - Lower time boundary (timestamp in milliseconds). Defaults to 0 (epoch).
 * @returns {Promise<{ success: boolean, workers: Array }>} - Result object with success status and array of worker performance entries.
 * @throws {Error} - If there is an error retrieving the data from the database.
 */
export async function get_worker_performance( { to=Date.now(), from=0 } ) {

    // Get the postgres pool
    const pool = await get_pg_pool()
    log.info( `Fetching worker performance entries from database between ${ new Date( from ).toISOString() } and ${ new Date( to ).toISOString() }` )

    // Prepare the query
    const query = `
        SELECT *
        FROM worker_performance
        WHERE updated_at <= $1 AND updated_at >= $2
        ORDER BY updated_at DESC
    `
    const values = [ to, from ]

    // Execute the query
    try {
        const result = await pool.query( query, values )
        log.info( `Retrieved ${ result.rowCount } worker performance entries from database` )
        return { success: !!result.rowCount, workers: result.rows || [] }
    } catch ( e ) {
        throw new Error( `Error retrieving worker performance from database: ${ e.message }` )
    }

}

/**
 * Marks workers that are not in a broadcast for this mining pool as 'unknown' status.
 * @param {Object} params
 * @param {Array} params.active_workers - Array of active worker objects to mark as stale.
 * @returns {Promise<void>}
 */
async function mark_workers_stale( { mining_pool_uid, active_workers=[] } ) {

    // Get the postgres pool
    const pool = await get_pg_pool()

    // If no active workers provided, skip
    if( active_workers.length === 0 ) return log.info( `No active workers provided to keep as current status` )

    // Prepare the query that marks workers that do not match the active mining_pool_uid and ip list inside active_workers as 'unknown' status
    const active_ips = active_workers.map( ( { ip } ) => ip )
    const query = `
        UPDATE workers
        SET status = 'unknown', updated_at = $1
        WHERE mining_pool_uid = $2 AND ip NOT IN ( ${ active_ips.map( ( _, i ) => `$${ i + 3 }` ).join( ', ' ) } )
    `
    const values = [ Date.now(), mining_pool_uid, ...active_ips ]

    // Execute the query
    try {
        const result = await pool.query( query, values )
        log.info( `Marked ${ result.rowCount } workers as 'unknown' status for mining pool ${ mining_pool_uid }` )
    } catch ( e ) {
        throw new Error( `Error marking workers as stale: ${ e.message }` )
    }

}

/**
 * Gets the number of unique country_code instances for workers where mining pool uid and ip are given
 * @param {Object<{ mining_pool_uid: string: string }>} params - optional
 * @returns {Promise<[string]>} Country codes for the workers of this pool
 */
export async function get_worker_countries_for_pool( { mining_pool_uid }={} ) {

    // Get the postgres pool
    const pool = await get_pg_pool()

    // Formulate query
    const wheres = [ 'status = $1' ]
    const values = [ 'up' ]

    if( mining_pool_uid ) {
        values.push( mining_pool_uid )
        wheres.push( `mining_pool_uid = $${ values.length }` )
    }

    const query = `
        SELECT DISTINCT country_code
        FROM workers
        ${ wheres.length > 0 ? `WHERE ${ wheres.join( ' AND ' ) }` : '' }
    `

    try {
        log.debug( `Fetching worker countries for pool ${ mining_pool_uid || 'all pools' } with query: ${ query } and values: `, values )
        const result = await pool.query( query, values )
        return result.rows.map( row => row.country_code )
    } catch ( e ) {
        throw new Error( `Error fetching worker countries for pool ${ mining_pool_uid }: ${ e.message }` )
    }

}

/**
 * Writes or updates worker broadcast metadata for a mining pool in Postgres.
 * @param {Object} params - Input parameters.
 * @param {string} params.mining_pool_uid - Unique identifier of the mining pool.
 * @param {string} params.mining_pool_ip - IP address of the mining pool.
 * @param {Array<object>} params.workers - Array of worker descriptors; only the length is used.
 * @returns {Promise<{success: true, last_known_worker_pool_size: number, updated: number}>} Result indicating success with metadata.
 * @throws {Error} If the Postgres pool is unavailable or if the database write fails.
 */
async function write_worker_broadcast_metadata( { mining_pool_uid, workers } ) {

    // Get the postgres pool
    const pool = await get_pg_pool()

    // Prepare the query with pg-format
    const last_known_worker_pool_size = workers.length
    const updated = Date.now()
    const metadata_query = `
        INSERT INTO worker_broadcast_metadata (mining_pool_uid, last_known_worker_pool_size, updated)
        VALUES ($1, $2, $3)
        ON CONFLICT (mining_pool_uid) DO UPDATE SET
            last_known_worker_pool_size = EXCLUDED.last_known_worker_pool_size,
            updated = EXCLUDED.updated
    `
    const broadcast_metadata = {
        mining_pool_uid,
        last_known_worker_pool_size,
        updated,
    }

    // Execute the query
    try {
        await pool.query( metadata_query, [ mining_pool_uid, last_known_worker_pool_size, updated ] )
        log.info( `Wrote worker broadcast metadata to database for mining pool ${ mining_pool_uid } with metadata: `, broadcast_metadata )
        return { success: true, ...broadcast_metadata }
    } catch ( e ) {
        throw new Error( `Error writing worker broadcast metadata to database: ${ e.message }` )
    }

}

/**
 * @param {Object} params - Query parameters.
 * @param {string} params.mining_pool_uid? - Unique identifier of the mining pool.
 * @returns {Promise<[
 *   { success: true, mining_pool_uid: string, last_known_worker_pool_size: number, updated: number } |
 *   ]>} Result object indicating success status and, if successful, the metadata row.
 * @throws {Error} If the Postgres pool is unavailable or a database query fails.
 */
export async function read_worker_broadcast_metadata( { mining_pool_uid, limit }={} ) {

    // Get the postgres pool
    const pool = await get_pg_pool()

    // Formulate query
    const wheres = []
    const values = []
    if( mining_pool_uid ) {
        values.push( mining_pool_uid )
        wheres.push( `mining_pool_uid = $${ values.length }` )
    }

    if( limit ) values.push( limit )

    // Prepare the query
    const query = `
        SELECT mining_pool_uid, last_known_worker_pool_size, updated
        FROM worker_broadcast_metadata
        ${ wheres.length > 0 ? `WHERE ${ wheres.join( ' AND ' ) }` : '' }
        ${ limit ? `LIMIT $${ values.length }` : '' }
    `

    // Execute the query
    try {
        const result = await pool.query( query, [ ...values ] )
        log.debug( `Read worker broadcast metadata from database for mining pool ${ mining_pool_uid }: `, result.rows[0] )
        return result.rows
    } catch ( e ) {
        throw new Error( `Error reading worker broadcast metadata from database: ${ e.message }` )
    }

}

/**
 * Retrieves worker rows for a specific mining pool from the database.
 * @param {Object} params - Query parameters.
 * @param {string} params.ip? - IP address of the worker.
 * @param {string} params.mining_pool_uid? - Unique identifier of the mining pool.
 * @param {string} params.mining_pool_url? - URL of the mining pool.
 * @param {string} params.country_code? - Country code of the worker; use 'any' to ignore this filter.
 * @param {string} params.status? - Status of the worker; defaults to null. Valid values are 'up', 'down', or 'unknown'.
 * @param {boolean} params.randomize? - If true, sample using tsm_system_rows extension to get random rows
 * @param {number} params.limit? - Maximum number of worker records to return.
 * @param {string} params.connection_type? - Connection type of the worker; use 'any' to ignore this filter. Valid values are 'datacenter' or 'residential'.
 * @returns {Promise<{success: true, workers: any[]} | {success: false, message: string}>} Result indicating success with workers or a not-found message.
 * @throws {Error} If the Postgres pool is unavailable or if the database query fails.
 */
export async function get_workers( { ip, mining_pool_uid, mining_pool_url, country_code, status, randomize, limit, connection_type } ) {
    // Get the postgres pool
    const pool = await get_pg_pool()

    // If country_code is 'any' then remove it
    if( [ 'any', 'ANY', 'undefined', 'null', '' ].includes( country_code ) ) country_code = null

    // If connection_type is 'any' then remove it
    if( [ 'any', 'ANY', 'undefined', 'null', '' ].includes( connection_type ) ) connection_type = null

    // Force country code to capitals
    if( country_code ) country_code = `${ country_code }`.toUpperCase()

    // Status must be up, down, or unknown
    if( status && ![ 'up', 'down', 'unknown' ].includes( sanetise_string( status ) ) ) {
        log.warn( `Invalid status filter provided: ${ status }, THIS SHOULD NEVER HAPPEN, defaulting to 'up'` )
        status = 'up'
    }

    // If url provided, sanetise it and remove trailing slash
    if( mining_pool_url ) {
        mining_pool_url = sanetise_string( mining_pool_url )
        if( mining_pool_url.endsWith( '/' ) ) mining_pool_url = mining_pool_url.replace( /\/+$/g, '' )
    }

    // Formulate the query
    const wheres = []
    const values = []
    if( ip ) {
        values.push( ip )
        wheres.push( `ip = $${ values.length }` )
    }
    if( mining_pool_uid ) {
        values.push( mining_pool_uid )
        wheres.push( `mining_pool_uid = $${ values.length }` )
    }
    if( mining_pool_url ) {
        values.push( mining_pool_url )
        wheres.push( `mining_pool_url = $${ values.length }` )
    }
    if( country_code ) {
        values.push( country_code )
        wheres.push( `country_code = $${ values.length }` )
    }
    if( status ) {
        values.push( status )
        wheres.push( `status = $${ values.length }` )
    }
    if( connection_type ) {
        values.push( connection_type )
        wheres.push( `connection_type = $${ values.length }` )
    }

    // Create the limit clause
    const simple_limit = limit && !randomize
    const randomize_limit = limit && randomize
    let limit_q = ``
    if( simple_limit ) {
        values.push( limit )
        limit_q = `LIMIT $${ values.length }`
    }
    if( randomize_limit ) {
        values.push( limit )
        limit_q = `TABLESAMPLE SYSTEM_ROWS ($${ values.length })`
    }
    if( !limit && randomize ) log.warn( `Randomize cannot sample without a limit` )

    // Prepare the query
    const query = `
        SELECT *
        FROM workers
        ${ randomize_limit ? limit_q : '' }
        ${ wheres.length > 0 ? `WHERE ${ wheres.join( ' AND ' ) }` : '' }
        ${ simple_limit ? limit_q : '' }
    `

    // Execute the query
    try {
        log.debug( query, [ ...values ] )
        const result = await pool.query( query, [ ...values ] )
        log.info( `Retrieved ${ result.rows?.length || 0 } workers from database for mining pool ${ mining_pool_uid }` )
        log.insane( `Workers retrieved: `, result.rows )
        return { success: !!result.rowCount, workers: result.rows || [] }
    } catch ( e ) {
        throw new Error( `Error retrieving workers from database: ${ e.message }` )
    }
}
