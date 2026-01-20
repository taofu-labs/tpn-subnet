import { cache, log } from "mentie"
import url from 'url'
import { promises as fs } from 'fs'
const { CI_MODE } = process.env

// Formulate disk path
const __dirname = url.fileURLToPath( new URL( '.', import.meta.url ) )
const cache_dir = `${ __dirname }/../cache`
const cache_persistence_path = `${ cache_dir }/.tpn_cache.json`.replaceAll( '//', '/' )

// Valid TPN cache keys
export const tpn_cache_keys = [

    'last_known_validators',
    'last_known_miners',

    'ip_addresses',
    'country_count',
    'ip_to_country',
    'country_code_to_ips',
    'country_code_to_name',
    'country_name_to_code',

    'miner_ip_to_country',
    'miner_country_code_to_ips',

    'miner_country_count',
    'miner_uids',
    'miner_uid_to_ip',
    'miner_ip_to_uid',
    'miner_country_to_uids',

    'worker_ip_addresses',
    'worker_country_code_to_ips',
    'worker_country_count',

]

/**
 * Retrieves a value from the TPN cache.
 * @param {string} key - The key to retrieve the cached value for.
 * @param {*} [default_value=undefined] - The default value to return if the key is not found in the cache.
 * @returns {*} - The cached value associated with the key, or the default value if not found.
 */
export function get_tpn_cache( key, default_value=undefined ) {

    // Check if the key is a valid TPN cache key
    if( !tpn_cache_keys.includes( key ) ) throw new Error( `Invalid TPN cache key: ${ key }` )

    // Get cache value
    const cache_value = cache( key )

    // If no value, return the default value
    if( cache_value === undefined ) return default_value

    // If the cache value is one the is tracked by reference, make a new version of it
    let immutable_cache_value = cache_value
    if( typeof cache_value == 'object' ) immutable_cache_value = { ...cache_value }
    if( Array.isArray( cache_value ) ) immutable_cache_value = [ ...cache_value ]

    // Return cached value or undefined
    return immutable_cache_value
}

/**
 * Sets a value in the TPN cache.
 * @param {Object} params - The cache parameters.
 * @param {string} params.key - The key to cache the value under.
 * @param {*} params.value - The value to cache.
 * @param {boolean} [params.merge=false] - Whether to merge with existing cache value.
 * @param {number} [params.expires_in_ms] - The expiration time in milliseconds.
 * @returns {*} - The cached value.
 */
export function set_tpn_cache( { key, value, merge=false, expires_in_ms } ) {

    // Check if the key is a valid TPN cache key
    if( !tpn_cache_keys.includes( key ) ) throw new Error( `Invalid TPN cache key: ${ key }` )

    // Check input type
    let input_type = typeof value
    if( Array.isArray( value ) ) input_type = 'array'

    // If the cache value is tracked by reference, make a new version
    let immutable_cache_value = value
    if( input_type == 'array' ) immutable_cache_value = [ ...value ]
    else if( input_type == 'object' ) immutable_cache_value = { ...value }

    // If merge requested, merge the new value with the existing cache value
    if( merge ) {
        let default_val = undefined
        if( input_type == 'array' ) default_val = []
        if( input_type == 'object' ) default_val = {}
        const existing_cache_value = get_tpn_cache( key, default_val )
        if( input_type == 'array' ) {
            immutable_cache_value = [ ...new Set( [ ...existing_cache_value, ...immutable_cache_value ] ) ]
        } else if( input_type == 'object' ) {
            immutable_cache_value = { ...existing_cache_value, ...immutable_cache_value }
        } else {
            log.warn( `Cannot merge non-object/array TPN cache values for key: ${ key }` )
        }
    }

    // Set cache value
    let type = typeof immutable_cache_value
    if( Array.isArray( immutable_cache_value ) ) type = 'array'
    const size = type == 'object' ? Object.keys( immutable_cache_value ).length : immutable_cache_value?.length
    log.insane( `Setting TPN cache key: ${ key }, ${ type } of ${ size } ${ type == 'object' ? 'keys' : 'size' }` )
    return cache( key, immutable_cache_value, expires_in_ms )

}

/**
 * Retrieves all cached values related to the TPN
 * @returns {Object} An object containing all cached values related to the TPN.
 */
export function get_complete_tpn_cache() {

    // Get all cache values
    const cache_values = {}
    log.info( `Retrieving complete TPN cache with keys:`, tpn_cache_keys )
    for( const key of tpn_cache_keys ) {
        cache_values[ key ] = get_tpn_cache( key )
    }

    // Return all cache values
    return cache_values

}

/**
 * Saves the complete TPN cache to disk at the configured path.
 * This function serializes the cache to JSON and writes it to a file.
 */
export async function save_tpn_cache_to_disk() {

    // Get the complete TPN cache
    const tpn_cache = get_complete_tpn_cache()
    log.info( `Saving TPN cache to disk at path: ${ cache_persistence_path }` )

    // Write the cache to disk async
    try {
        await fs.mkdir( cache_dir, { recursive: true } )
        await fs.writeFile( cache_persistence_path, JSON.stringify( tpn_cache, null, 2 ) )
        log.info( `TPN cache saved to disk successfully` )
    } catch ( e ) {
        log.error( `Error saving TPN cache to disk:`, e )
    }

}

/**
 * Restores the TPN cache from disk at the configured path.
 * This function reads the cache from a file and restores it to the in-memory cache.
 */
export async function restore_tpn_cache_from_disk() {

    log.info( `Restoring TPN cache from disk at path: ${ cache_persistence_path }` )

    // Read the cache from disk async
    try {
        const data = await fs.readFile( cache_persistence_path, 'utf8' ).catch( e => {
            log.warn( `No existing TPN cache file found at path: ${ cache_persistence_path }` )
            return false
        } )
        if( !data ) return
        const tpn_cache = JSON.parse( data )
        log.info( `TPN cache restored from disk successfully` )

        // Cache the values
        cache.restore( tpn_cache )
        log.info( `TPN cache restored to in-memory cache` )

    } catch ( e ) {
        log.error( `Error restoring TPN cache from disk:`, e )
    }

}