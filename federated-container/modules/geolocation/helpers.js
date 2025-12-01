import { cache, log } from 'mentie'
import { is_data_center } from './ip2location.js'

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
    /amazon/i,
    /aws/i,
    /cloudfront/i,
    /google/i,
    /microsoft/i,
    /azure/i,
    /digitalocean/i,
    /linode/i,
    /vultr/i,
    /ovh/i,
    /hetzner/i,
    /upcloud/i,
    /scaleway/i,
    /contabo/i,
    /ionos/i,
    /rackspace/i,
    /softlayer/i,
    /alibaba/i,
    /tencent/i,
    /baidu/i,
    /cloudflare/i,
    /fastly/i,
    /akamai/i,
    /edgecast/i,
    /level3/i,
    /limelight/i,
    /incapsula/i,
    /stackpath/i,
    /maxcdn/i,
    /cloudsigma/i,
    /quadranet/i,
    /psychz/i,
    /choopa/i,
    /leaseweb/i,
    /hostwinds/i,
    /equinix/i,
    /colocrossing/i,
    /hivelocity/i,
    /godaddy/i,
    /bluehost/i,
    /hostgator/i,
    /dreamhost/i,
    /hurricane electric/i,
    // Generic patterns indicating data centers
    /colo/i,
    /datacenter/i,
    /serverfarm/i,
    /hosting/i,
    /cloud\s*services?/i,
    /dedicated\s*server/i,
    /vps/i
]

/**
 * Get geolocation data for an IP address
 * @param {string} ip - The IP address to lookup
 * @returns {Promise<{ country: string, datacenter: boolean }>} - The geolocation data
 */
export async function ip_geodata( ip ) {
    const { default: geoip } = await import( 'geoip-lite' )
    const cached_value = cache( `geoip:${ ip }` )
    if( cached_value ) return cached_value
    const { country } = geoip.lookup( ip ) || {}
    const datacenter = !!ip && await is_data_center( ip )
    const connection_type = datacenter ? 'datacenter' : 'residential'
    const data = { country_code: country, datacenter, connection_type }
    return cache( `geoip:${ ip }`, data, 60_000 )
}