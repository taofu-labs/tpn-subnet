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

// Check if MaxMind web service credentials are configured
const { MAXMIND_ACCOUNT_ID, MAXMIND_LICENSE_KEY } = process.env
const maxmind_insights_enabled = !!MAXMIND_ACCOUNT_ID && !!MAXMIND_LICENSE_KEY


/**
 * Query the ip_geodata_cache table for a non-expired entry.
 * @param {string} ip - The IP address to look up.
 * @returns {Promise<object|null>} - Cached row or null if not found / expired.
 */
async function get_db_cached_geodata( ip ) {

    try {

        const pool = await get_pg_pool()
        const now = Date.now()

        const { rows } = await pool.query(
            `SELECT * FROM ip_geodata_cache WHERE ip = $1 AND expires_at > $2 LIMIT 1`,
            [ ip, now ]
        )

        if( !rows.length ) return null

        const row = rows[0]
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
 * Get geolocation data for an IP address.
 *
 * When MAXMIND_ACCOUNT_ID and MAXMIND_LICENSE_KEY are set, uses the MaxMind
 * Insights web API with multi-layer caching (in-memory → postgres → API).
 * Otherwise falls back to geoip-lite + ip2location with postgres caching.
 *
 * @param {string} ip - The IP address to lookup.
 * @returns {Promise<{ country_code: string, datacenter: boolean, connection_type: string }>}
 */
export async function ip_geodata( ip ) {

    // --- Layer 1: in-memory cache (both paths) ---
    const cache_key = `geoip:${ ip }`
    const cached_value = cache( cache_key )
    if( cached_value ) return cached_value


    // --- Layer 2: database cache ---
    const db_cached = await get_db_cached_geodata( ip )

    if( db_cached ) {
        // Warm the in-memory cache from the db hit
        cache( cache_key, db_cached, GEODATA_CACHE_EXPIRY_MS )
        return db_cached
    }


    // --- Layer 3: resolve fresh data ---

    if( maxmind_insights_enabled ) {
        return ip_geodata_from_maxmind( ip, cache_key )
    }

    return ip_geodata_from_geoip_lite( ip, cache_key )

}


/**
 * Resolve geodata via the MaxMind Insights web API.
 * On failure, falls back to geoip-lite without caching to the database.
 */
async function ip_geodata_from_maxmind( ip, cache_key ) {

    try {

        const { WebServiceClient } = await import( '@maxmind/geoip2-node' )

        const client = new WebServiceClient( MAXMIND_ACCOUNT_ID, MAXMIND_LICENSE_KEY, {
            timeout: 5000,
        } )

        const response = await client.insights( ip )

        const country_code = response.country?.isoCode || undefined
        const datacenter = !!response.traits?.isHostingProvider
        const connection_type = datacenter ? 'datacenter' : 'residential'

        const data = { country_code, datacenter, connection_type }

        // Extra fields stored in db but not returned
        const extras = {
            userType: response.traits?.userType,
            connectionType: response.traits?.connectionType,
            userCount: response.traits?.userCount,
        }

        // Persist to db and warm in-memory cache
        await save_db_cached_geodata( ip, data, extras )
        cache( cache_key, data, GEODATA_CACHE_EXPIRY_MS )

        return data

    } catch ( e ) {

        // Log the error and fall back to geoip-lite (no db save on fallback)
        log.error( `MaxMind Insights API error for ${ ip }: ${ e.message }` )
        return ip_geodata_from_geoip_lite( ip, cache_key, { skip_db_save: true } )

    }

}


/**
 * Resolve geodata via geoip-lite + ip2location (the original path).
 * By default saves to the database cache; set skip_db_save when falling back from an API error.
 */
async function ip_geodata_from_geoip_lite( ip, cache_key, { skip_db_save = false } = {} ) {

    const { default: geoip } = await import( 'geoip-lite' )

    const { country } = geoip.lookup( ip ) || {}
    const datacenter = !!ip && await is_data_center( ip )
    const connection_type = datacenter ? 'datacenter' : 'residential'

    const data = { country_code: country, datacenter, connection_type }

    // Persist to db (unless this is a fallback from a failed API call)
    if( !skip_db_save ) {
        await save_db_cached_geodata( ip, data )
    }

    // Use a short in-memory TTL on fallback so MaxMind is retried after recovery,
    // otherwise align with the DB cache TTL
    const in_memory_ttl_ms = skip_db_save ? 5 * 60 * 1000 : GEODATA_CACHE_EXPIRY_MS
    cache( cache_key, data, in_memory_ttl_ms )

    return data

}
