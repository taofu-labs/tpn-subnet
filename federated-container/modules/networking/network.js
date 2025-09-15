import { lookup } from "dns/promises"
import { cache, is_ipv4, log, random_number_between, random_string_of_length, wait } from "mentie"
import { v4 as uuidv4 } from "uuid"
import { run } from "../system/shell.js"

export function ip_from_req( request ) {

    // Extract the ip address from the request object
    let { ip: request_ip, ips, connection, socket } = request

    // If the request has no ips, use the connection or socket remote address
    let spoofable_ip = request_ip || ips[0] || request.get( 'x-forwarded-for' )

    // Grab the remote address from the connection or socket
    let unspoofable_ip = connection.remoteAddress || socket.remoteAddress

    // If unspoofable ip is a ipv6 address with a v4-mapped prefix, remove it
    unspoofable_ip = unspoofable_ip?.replace( '::ffff:', '' )
    
    return { unspoofable_ip, spoofable_ip }
}

export function request_is_local( request ) {

    // Get the ip of the originating request
    const { unspoofable_ip, spoofable_ip } = ip_from_req( request )

    // Log out the ip address of the request
    if( unspoofable_ip ) log.info( `Request from ${ unspoofable_ip }` )
    if( !unspoofable_ip ) {
        log.info( `Cannot determine ip address of request, but it might be coming from ${ spoofable_ip } based on headers alone` )
        // Assume remote when unknown
        return false
    }

    // Check if the ip is local
    const local_ip_patterns_v4_and_v6 = [
        // Localhost
        /^127\.0\.0\.1$/,
        /^::1$/,
        /^::ffff:127\.0\.0\.1$/,
        // Note: this is the ipv6 mock mask of the subnet defined in validator.docker-compose.yml
        /^172\.29\.187\./,
        /^::ffff:172\.29\.187\./,
    ]
    const is_local = local_ip_patterns_v4_and_v6.some( pattern => pattern.test( unspoofable_ip ) )   
    
    return is_local

}

/**
 * 
 * @param {Object} params - Parameters for the domain resolution.
 * @param {string} params.domain - The domain to resolve.
 * @param {string} [params.fallback] - Fallback IP address to return if resolution fails.
 * @returns {Promise<{ ip: string }>} - A promise that resolves to an object containing the resolved IP address.
 */
export async function resolve_domain_to_ip( { domain, fallback, family=4 } ) {

    // Normalise url input to domain format
    try {
        domain = new URL( domain ).hostname.replace( /^www\./, '' )
        log.info( `Normalized domain ${ domain }` )
    } catch {
        log.info( `Did not normalize domain ${ domain }` )
    }

    // If the domain is already an ipv4 address, return it directly
    if( is_ipv4( domain ) ) return { ip: domain }

    try {
        if( !domain ) throw new Error( `Domain is required` )
        const cached_value = cache( `resolved_domain_${ domain }` )
        if( cached_value ) return cached_value
        const { ip=fallback } = await lookup( domain, { family } )
        return cache( `resolved_domain_${ domain }`, { ip }, 15 * 60 * 1000 ) // Cache for 15 minutes
    } catch ( e ) {
        log.warn( `Failed to resolve domain ${ domain }: ${ e.message }` )
        return { ip: fallback }
    }

}

/**
 * Function that gets available network interfaces on the machine
 * @param {Object} params - Parameters for generating free network interfaces.
 * @param {string} [params.log_tag] - Optional tag for logging.
 * @param {boolean} [params.verbose] - Optional flag for verbose logging.
 * @returns {Promise<{ interface_id: string, veth_id: string, namespace_id: string, veth_subnet_prefix: string, clear_interfaces: Function }>} - A promise that resolves to an object containing the generated network interface IDs and a function to clear them.
 */
export async function get_free_interfaces( { log_tag=uuidv4(), verbose } ) {

    // Generators
    const mk_interface_id = () => `tpn${ random_string_of_length( 5 ) }`
    const mk_veth_id = () => `tpn${ random_string_of_length( 5 ) }`
    const mk_subnet_prefix = () => `10.200.${ random_number_between( 1, 254 ) }`
    const mk_namespace_id = () => `ns_${ mk_interface_id() }`

    // Run specific variables
    let interface_id = mk_interface_id()
    let veth_id = mk_veth_id()
    let veth_subnet_prefix = mk_subnet_prefix()
    let { stdout: default_route } = await run( `ip route show default | awk '/^default/ {print $3}'`, { silent: !verbose, log_tag } )
    default_route = default_route.trim()
    let namespace_id = mk_namespace_id()

    // Make sure there are no duplicates
    let interface_id_in_use = cache( `interface_id_in_use_${ interface_id }` )
    let veth_id_in_use = cache( `veth_id_in_use_${ veth_id }` )
    let namespace_id_in_use = cache( `namespace_id_in_use_${ namespace_id }` )
    let veth_subnet_prefix_in_use = cache( `veth_subnet_prefix_in_use_${ veth_subnet_prefix }` )
    let attempts = 1
    const max_attempts = 60
    while( interface_id_in_use || veth_id_in_use || namespace_id_in_use || veth_subnet_prefix_in_use ) {
    
        log.info( `[WHILE] Checking for free interfaces, veth, namespace, subnet prefix` )
    
        // If we have exceeded the max attempts, something is very wrong, error
        if( attempts > max_attempts ) {
            log.error( `${ log_tag } Exceeded max attempts to generate unique ids, trace: `, {
                interface_id_in_use,
                veth_id_in_use,
                namespace_id_in_use,
                veth_subnet_prefix_in_use,
                interface_id,
                veth_id,
                namespace_id,
                veth_subnet_prefix,
                attempts,
            } )
            throw new Error( `${ log_tag } Exceeded max attempts to generate unique ids` )
        }
    
        if( verbose ) log.info( `${ log_tag } Collision in ids found: `, {
            interface_id_in_use,
            veth_id_in_use,
            namespace_id_in_use,
            veth_subnet_prefix_in_use,
            interface_id,
            veth_id,
            namespace_id,
        } )
        if( interface_id_in_use ) {
            const new_interface_id = mk_interface_id()
            log.info( `${ log_tag } Regenerating interface_id from ${ interface_id } to ${ new_interface_id }` )
            interface_id = new_interface_id
            interface_id_in_use = cache( `interface_id_in_use_${ interface_id }` )
        }
        if( veth_id_in_use ) {
            const new_veth_id = mk_veth_id()
            log.info( `${ log_tag } Regenerating veth_id from ${ veth_id } to ${ new_veth_id }` )
            veth_id = new_veth_id
            veth_id_in_use = cache( `veth_id_in_use_${ veth_id }` )
        }
        if( namespace_id_in_use ) {
            const new_namespace_id = mk_namespace_id()
            log.info( `${ log_tag } Regenerating namespace_id from ${ namespace_id } to ${ new_namespace_id }` )
            namespace_id = new_namespace_id
            namespace_id_in_use = cache( `namespace_id_in_use_${ namespace_id }` )
        }
        if( veth_subnet_prefix_in_use ) {
            const new_veth_subnet_prefix = mk_subnet_prefix()
            log.info( `${ log_tag } Regenerating veth_subnet_prefix from ${ veth_subnet_prefix } to ${ new_veth_subnet_prefix }` )
            veth_subnet_prefix = new_veth_subnet_prefix
            veth_subnet_prefix_in_use = cache( `veth_subnet_prefix_in_use_${ veth_subnet_prefix }` )
        }
    
        if( verbose ) log.info( `${ log_tag } Trace of ids: `, {
            interface_id,
            veth_id,
            namespace_id,
            veth_subnet_prefix,
            interface_id_in_use,
            veth_id_in_use,
            namespace_id_in_use,
            veth_subnet_prefix_in_use
        } )
    
        // Add a tiny delay to prevent possible OOM when this logic fails for some reason
        const wait_time = attempts * 1000
        log.info( `${ log_tag } Waiting ${ wait_time }ms before next attempt to generate unique ids` )
        await wait( wait_time )
        attempts++
    
    }

    // Mark the ids as in use
    cache( `interface_id_in_use_${ interface_id }`, true, 120_000 )
    cache( `veth_id_in_use_${ veth_id }`, true, 120_000 )
    cache( `namespace_id_in_use_${ namespace_id }`, true, 120_000 )
    cache( `veth_subnet_prefix_in_use_${ veth_subnet_prefix }`, true, 120_000 )
    log.info( `${ log_tag } Generated unique ids: `, {
        interface_id,
        veth_id,
        namespace_id,
        veth_subnet_prefix,
        default_route
    } )

    // Helper function to mark interfaces as not in use in cache
    const clear_interfaces = () => {
        cache( `interface_id_in_use_${ interface_id }`, false )
        cache( `veth_id_in_use_${ veth_id }`, false )
        cache( `namespace_id_in_use_${ namespace_id }`, false )
        cache( `veth_subnet_prefix_in_use_${ veth_subnet_prefix }`, false )
    }


    return {
        interface_id,
        veth_id,
        namespace_id,
        veth_subnet_prefix,
        default_route,
        clear_interfaces
    }


}