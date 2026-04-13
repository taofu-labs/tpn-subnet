import { cache, log } from 'mentie'
import { is_data_center } from './ip2location.js'
import { get_pg_pool } from '../database/postgres.js'

// Helper that has all country names
export const region_names = new Intl.DisplayNames( [ 'en' ], { type: 'region' } )

/**
 * Converts a country code to its full country name.
 * @param {string} code - Country code (case insensitive).
 * @returns {string|undefined} - Country name, or undefined if unknown.
 */
export const country_name_from_code = code => {
    if( !code ) return code
    code = `${ code }`.toUpperCase().trim()
    try {
        return region_names.of( code )
    } catch {
        log.info( `Unknown country code: ${ code }` )
        return code
    }
}

export const geolocation_update_interval_ms = 60_000 * 60 * 24

// Datacenter name patterns (including educated guesses)
export const datacenter_patterns = [
    /amazon/i, /aws/i, /cloudfront/i, /google/i, /microsoft/i, /azure/i,
    /digitalocean/i, /linode/i, /vultr/i, /ovh/i, /hetzner/i, /upcloud/i,
    /scaleway/i, /contabo/i, /ionos/i, /rackspace/i, /softlayer/i,
    /alibaba/i, /tencent/i, /baidu/i, /cloudflare/i, /fastly/i, /akamai/i,
    /edgecast/i, /level3/i, /limelight/i, /incapsula/i, /stackpath/i,
    /maxcdn/i, /cloudsigma/i, /quadranet/i, /psychz/i, /choopa/i,
    /leaseweb/i, /hostwinds/i, /equinix/i, /colocrossing/i, /hivelocity/i,
    /godaddy/i, /bluehost/i, /hostgator/i, /dreamhost/i,
    /hurricane electric/i,
    // Generic patterns indicating data centers
    /colo/i, /datacenter/i, /serverfarm/i,
    /hosting/i, /cloud\s*services?/i, /dedicated\s*server/i, /vps/i
]


// Cache expiration: 30 days in milliseconds
const GEODATA_CACHE_EXPIRY_DAYS = 30
const GEODATA_CACHE_EXPIRY_MS = GEODATA_CACHE_EXPIRY_DAYS * 24 * 60 * 60 * 1000
const GEODATA_FALLBACK_CACHE_EXPIRY_MS = 5 * 60 * 1000

// Check if MaxMind web service credentials are configured
const { MAXMIND_ACCOUNT_ID, MAXMIND_LICENSE_KEY } = process.env
const maxmind_insights_enabled = !!MAXMIND_ACCOUNT_ID && !!MAXMIND_LICENSE_KEY


/**
 * Query the ip_geodata_cache table for a non-expired entry.
 * @param {string} ip - The IP address to look up.
 * @returns {Promise<object|null>} - Cached row or null if not found / expired.
 */
export async function get_db_cached_geodata( ip ) {

    try {

        const pool = await get_pg_pool()
        const now = Date.now()

        const { rows } = await pool.query(
            `SELECT * FROM ip_geodata_cache WHERE ip = $1 AND expires_at > $2 LIMIT 1`,
            [ ip, now ]
        )

        if( !rows.length ) return null

        const [ row ] = rows
        return {
            country_code: row.country,
            datacenter: row.datacenter,
            connection_type: row.connection_type,
        }

    } catch ( e ) {
        log.warn( `ip_geodata_cache db lookup failed for ${ ip }: ${ e.message }` )
        return null
    }

}


/**
 * Save geodata to the ip_geodata_cache table (upsert).
 * @param {string} ip - The IP address.
 * @param {object} data - The geodata to cache.
 * @param {object} [extras={}] - Additional MaxMind fields to store.
 */
async function save_db_cached_geodata( ip, data, extras = {} ) {

    try {

        const pool = await get_pg_pool()
        const now = Date.now()
        const expires_at = now + GEODATA_CACHE_EXPIRY_MS

        await pool.query( `
            INSERT INTO ip_geodata_cache ( ip, country, datacenter, connection_type, user_type, connection_type_raw, user_count, updated_at, expires_at )
            VALUES ( $1, $2, $3, $4, $5, $6, $7, $8, $9 )
            ON CONFLICT ( ip ) DO UPDATE SET
                country = EXCLUDED.country,
                datacenter = EXCLUDED.datacenter,
                connection_type = EXCLUDED.connection_type,
                user_type = EXCLUDED.user_type,
                connection_type_raw = EXCLUDED.connection_type_raw,
                user_count = EXCLUDED.user_count,
                updated_at = EXCLUDED.updated_at,
                expires_at = EXCLUDED.expires_at
        `, [
            ip,
            data.country_code || null,
            data.datacenter,
            data.connection_type,
            extras.userType ?? null,
            extras.connectionType ?? null,
            extras.userCount ?? null,
            now,
            expires_at,
        ] )

    } catch ( e ) {
        log.warn( `ip_geodata_cache db save failed for ${ ip }: ${ e.message }` )
    }

}


/**
 * Cache geodata in memory together with the source that produced it.
 * @param {Object} options
 * @param {string} options.ip - IP address used for the cache key.
 * @param {Object} options.geodata - Geodata payload to cache.
 * @param {string} options.source - Resolution source for this payload.
 * @param {number} options.ttl - Cache TTL in milliseconds.
 */
function save_memory_cached_geodata( { ip, geodata, source, ttl } ) {

    cache( `geoip:${ ip }`, geodata, ttl )
    cache( `geoip_source:${ ip }`, source, ttl )
    log.insane( `Cached geodata for ${ ip } from source "${ source }" with TTL ${ ttl / 1000 }s` )

}


/**
 * Returns true when a source should keep only a short in-memory TTL so MaxMind
 * can be retried soon after recovery.
 * @param {string} source - Resolution source.
 * @returns {boolean} Whether the source is a fallback.
 */
function is_fallback_source( source ) {

    if( source === `validator` ) return true
    if( source === `geoip_lite` && maxmind_insights_enabled ) return true
    return false

}


/**
 * Get geolocation data for an IP address.
 *
 * Resolution layers (first hit wins):
 *   1. In-memory cache
 *   2. PostgreSQL cache
 *   3. MaxMind Insights API (when credentials are configured)
 *   4. Peer validators (ask other validators for their cached geodata)
 *   5. geoip-lite + ip2location (local fallback)
 *
 * When `authoritative_only` is true, only layers 1-3 are used — this prevents
 * recursive validator-to-validator calls and avoids low-fidelity geoip-lite data.
 *
 * @param {string} ip - The IP address to lookup.
 * @param {Object} [options] - Options object.
 * @param {boolean} [options.authoritative_only=false] - Skip peer validators and geoip-lite fallback.
 * @returns {Promise<{ country_code: string, datacenter: boolean, connection_type: string }|null>}
 */
export async function ip_geodata( ip, { authoritative_only = false } = {} ) {

    const cache_key = `geoip:${ ip }`
    const cache_source_key = `geoip_source:${ ip }`
    let geodata = null
    let geodata_source = null
    let maxmind_extras = null

    // --- Layer 1: in-memory cache ---
    geodata = cache( cache_key )
    geodata_source = cache( cache_source_key ) || `memory`

    // Keep fallback cache entries out of authoritative-only responses, and
    // avoid resetting TTLs or rewriting DB state on memory hits.
    if( geodata && ( !authoritative_only || !is_fallback_source( geodata_source ) ) ) return geodata
    geodata = null
    geodata_source = null

    // --- Layer 2: database cache ---
    if( !geodata ) {
        geodata = await get_db_cached_geodata( ip )
        if( geodata ) geodata_source = `db`
        log.debug( `DB cache ${ geodata ? 'hit' : 'miss' } for ${ ip }` )
    }

    // --- Layer 3: MaxMind Insights API ---
    if( !geodata && maxmind_insights_enabled ) {
        const result = await ip_geodata_from_maxmind( ip )
        geodata = result?.data
        maxmind_extras = result?.extras
        if( geodata ) geodata_source = `maxmind`
        log.debug( `MaxMind Insights API ${ geodata ? 'hit' : 'miss' } for ${ ip }` )
    }

    // In authoritative-only mode, return null if layers 1-3 had no data
    if( authoritative_only && !geodata ) return null

    // --- Layer 4: peer validators ---
    if( !geodata ) {
        geodata = await ip_geodata_from_validators( ip )
        if( geodata ) geodata_source = `validator`
        log.debug( `Validator peer ${ geodata ? 'hit' : 'miss' } for ${ ip }` )
    }

    // --- Layer 5: geoip-lite (final fallback) ---
    if( !geodata ) {
        geodata = await ip_geodata_from_geoip_lite( ip )
        if( geodata ) geodata_source = `geoip_lite`
        log.debug( `geoip-lite ${ geodata ? 'hit' : 'miss' } for ${ ip }` )
    }


    // --- Persist and cache the result ---
    // Memory hits have already returned earlier, so this section handles
    // database-backed or freshly resolved data.
    // MaxMind results and geoip-lite as the primary source keep the long TTL.
    // True fallback sources (validators, geoip-lite when MaxMind is enabled)
    // get a short in-memory TTL so MaxMind is retried after recovery.
    const ttl = is_fallback_source( geodata_source ) ? GEODATA_FALLBACK_CACHE_EXPIRY_MS : GEODATA_CACHE_EXPIRY_MS

    if( geodata_source === `maxmind` ||  geodata_source === `geoip_lite` && !maxmind_insights_enabled  ) {
        await save_db_cached_geodata( ip, geodata, maxmind_extras ?? undefined )
    }

    save_memory_cached_geodata( { ip, geodata, source: geodata_source, ttl } )
    log.info( `Resolved geodata for ${ ip } from source "${ geodata_source }"` )

    return geodata

}


/**
 * Resolve geodata via the MaxMind Insights web API.
 * Returns { data, extras } on success, null on failure.
 */
async function ip_geodata_from_maxmind( ip ) {

    try {

        // Reuse a single WebServiceClient instance across calls
        let client = cache( `maxmind:client` )
        if( !client ) {
            const { WebServiceClient } = await import( '@maxmind/geoip2-node' )
            client = new WebServiceClient( MAXMIND_ACCOUNT_ID, MAXMIND_LICENSE_KEY, { timeout: 5000 } )
            cache( `maxmind:client`, client )
        }

        const response = await client.insights( ip )

        const country_code = response.country?.isoCode || undefined
        const datacenter = !!response.traits?.isHostingProvider
        const connection_type = datacenter ? 'datacenter' : 'residential'

        const data = { country_code, datacenter, connection_type }
        const extras = {
            userType: response.traits?.userType,
            connectionType: response.traits?.connectionType,
            userCount: response.traits?.userCount,
        }

        return { data, extras }

    } catch ( e ) {

        log.error( `MaxMind Insights API error for ${ ip }: ${ e.message }` )
        return null

    }

}


/**
 * Resolve the public geodata endpoint for a peer validator.
 * Uses the validator's advertised public protocol/host/port, mirroring the
 * rest of the validator broadcast flow.
 * @param {Object} peer - Validator peer metadata.
 * @returns {Promise<string>} Peer geodata endpoint URL.
 */
async function get_validator_geodata_endpoint( peer ) {

    const endpoint_cache_key = `validator:geodata_endpoint:${ peer.ip }`
    const cached_endpoint = cache( endpoint_cache_key )
    if( cached_endpoint ) return cached_endpoint

    const { abort_controller } = await import( 'mentie' )
    const { fetch_options } = abort_controller( { timeout_ms: 5_000 } )

    const health_res = await fetch( `http://${ peer.ip }:3000/`, fetch_options )
    if( !health_res.ok ) throw new Error( `Peer ${ peer.ip } metadata returned ${ health_res.status }` )

    const health_data = await health_res.json()
    const protocol = health_data.SERVER_PUBLIC_PROTOCOL || `http`
    const host = health_data.SERVER_PUBLIC_HOST || peer.ip
    const port = health_data.SERVER_PUBLIC_PORT || 3000
    const endpoint = `${ protocol }://${ host }:${ port }/validator/broadcast/geodata`

    cache( endpoint_cache_key, endpoint, 5 * 60 * 1000 )
    return endpoint

}


/**
 * Resolve geodata by querying peer validators for their cached data.
 * Races all peers concurrently via Promise.any — first successful response wins.
 * Returns null if no peer has cached data for the IP.
 */
async function ip_geodata_from_validators( ip ) {

    try {

        // Dynamic imports to avoid circular dependency (validators.js → helpers.js)
        const { abort_controller } = await import( 'mentie' )
        const { get_validators } = await import( '../networking/validators.js' )

        // Get peer validators, excluding self
        const { SERVER_PUBLIC_HOST } = process.env
        const all_validators = await get_validators()
        const peers = all_validators.filter( v => v.ip !== SERVER_PUBLIC_HOST && v.ip !== '0.0.0.0' )

        if( !peers.length ) {
            log.info( `No validator peers available for geodata fallback` )
            return null
        }

        // Query a single peer with a 5-second timeout
        const query_peer = async ( peer ) => {
            const { fetch_options } = abort_controller( { timeout_ms: 5_000 } )
            const peer_geodata_endpoint = await get_validator_geodata_endpoint( peer )
            const geodata_url = `${ peer_geodata_endpoint }/${ encodeURIComponent( ip ) }`
            const res = await fetch( geodata_url, fetch_options )
            if( !res.ok ) throw new Error( `Peer ${ peer.ip } returned ${ res.status }` )
            const body = await res.json()
            if( !body?.success || !body?.data ) throw new Error( `Peer ${ peer.ip } has no data` )
            log.info( `Peer ${ peer.ip } has cached geodata for ${ ip }` )
            return body.data
        }

        // Race all peers — first successful response wins
        const data = await Promise.any( peers.map( query_peer ) )
        log.info( `Got geodata for ${ ip } from validator peer` )
        return data

    } catch ( e ) {

        // AggregateError means all peers failed, anything else is unexpected
        log.info( `No validator peers had cached geodata for ${ ip }` )
        return null

    }

}


/**
 * Resolve geodata via geoip-lite + ip2location (the original path).
 */
async function ip_geodata_from_geoip_lite( ip ) {

    const { default: geoip } = await import( 'geoip-lite' )

    const { country } = geoip.lookup( ip ) || {}
    const datacenter = !!ip && await is_data_center( ip )
    const connection_type = datacenter ? 'datacenter' : 'residential'

    return { country_code: country, datacenter, connection_type }

}
