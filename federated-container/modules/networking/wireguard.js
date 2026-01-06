import { cache, is_ipv4, log, multiline_trim, random_number_between, sanetise_ipv4, wait } from "mentie"
import { run } from "../system/shell.js"
import { generate_challenge } from "../scoring/challenge_response.js"
import { get_free_interfaces } from "./network.js"

// Global path config
const tmp_folder = '/etc/wireguard'

// Timeout used for curl commands
const { CI_MODE } = process.env
const test_timeout_seconds = CI_MODE ? 10 : 30

// Split multi-line commands into an array of commands
const split_ml_commands = commands => commands.split( '\n' ).map( c => c.replace( /#.*$/gm, '' ) ).filter( c => c.trim() ).map( c => c.trim() )

/**
 * Waits for a given IP address to become free (not in use) within a specified timeout period.
 * @param {Object} options - The options for the function.
 * @param {string} options.ip_address - The IP address to check.
 * @param {number} [options.timeout=test_timeout_ms] - The maximum time to wait for the IP address to become free, in milliseconds.
 * @throws {Error} Throws an error if no IP address is provided.
 * @returns {Promise<boolean>} Resolves to `true` if the IP address becomes free within the timeout, or `false` if it remains in use.
 */
export async function wait_for_ip_free( { ip_address, timeout_s=test_timeout_seconds, log_tag=Date.now(), verbose=false } ) {

    log.info( log_tag, `Waiting for IP address ${ ip_address } to become free` )

    // Check if the ip address is valid
    if( !ip_address ) throw new Error( `No ip address provided` )

    // Sanetise the ip address
    ip_address = sanetise_ipv4( { ip: ip_address, validate: true, error_on_invalid: true } )

    // Check the cache for the ip address being in process
    let ip_being_processed = cache( `ip_being_processed_${ ip_address }` )

    // Check if the ip address is already in use
    const { stdout, stderr } = await run( `ip addr show | grep ${ ip_address } || true`, { silent: !verbose, verbose, log_tag } )
    let ip_taken = stdout?.includes( ip_address )

    // If ip not taken, return out
    if( !ip_taken ) {
        log.debug( log_tag, `IP address ${ ip_address } is free, no need to wait` )
        return true
    }

    // If ip is taken, wait for it to be free
    let waited_for = 0
    const timeout = timeout_s * 1000
    const interval = 5000
    while( ip_taken && waited_for < timeout ) {
        log.info( log_tag, `[WHILE] IP address ${ ip_address } is in use, waiting ${ interval / 1000 }s (waited for ${ waited_for / 1000 }s) for it to become free...` )
        await wait( interval )
        waited_for += interval

        // Check on interface level
        const { stdout, stderr } = await run( `ip addr show | grep ${ ip_address } || true`, { silent: !verbose } )

        // Check on cache level
        ip_being_processed = cache( `ip_being_processed_${ ip_address }` )

        ip_taken = stdout?.includes( ip_address ) || ip_being_processed
        if( !ip_taken ) break
    }

    // If ip is still taken, return false
    if( ip_taken ) {
        log.warn( log_tag, `IP address ${ ip_address } is still in use after ${ waited_for / 1000 } seconds` )
        return false
    }
    log.info( log_tag, `IP address ${ ip_address } is free after ${ waited_for / 1000 } seconds` )
    return true

}

/**
 * Cleans up TPN network namespaces.
 * @param {Object} [params] - Cleanup parameters.
 * @param {string[]} [params.namespaces] - Array of namespace IDs to clean up. If not provided, cleans all TPN namespaces.
 * @returns {Promise<boolean>} - True if namespaces were cleaned up, false otherwise.
 */
export async function clean_up_tpn_namespaces( { namespaces }={} ) {

    log.info( `Cleaning up ${ namespaces?.length || 'all' } namespaces` )

    // Get all namespaces
    if( !namespaces ) {
        log.info( `No namespaces provided, getting all namespaces` )
        const { stdout } = await run( `ip netns list`, { silent: true } )
        namespaces = stdout?.split( '\n' ).filter( line => line.includes( 'tpn' ) ).map( line => line.split( ':' )[ 0 ].trim() )   
        log.debug( `Found TPN namespaces:`, namespaces )
    }

    // If no namespaces found, return
    if( !namespaces || !namespaces?.length ) {
        log.info( `No namespaces found to clean up` )
        return false
    }

    // Loop over namespaces and delete them
    log.info( `Deleting ${ namespaces?.length } namespaces` )
    for( const namespace_id of namespaces ) {
        log.debug( `Cleaning up namespace ${ namespace_id }` )
        await run( `ip netns del ${ namespace_id }`, { silent: true } )
        log.debug( `Deleted namespace ${ namespace_id }` )
    }

    return !!namespaces?.length

}

/**
 * Cleans up TPN interfaces by deleting their links, routing tables, 
 * and configuration files. Can operate in dry-run mode to simulate the cleanup process.
 *
 * @param {Object} [options={}] - The options for the cleanup process.
 * @param {string[]} [options.interfaces] - The list of interface names to clean up. If not provided, all TPN interfaces will be targeted.
 * @param {string[]} [options.ip_addresses] - The list of IP addresses to find associated interfaces for cleanup.
 * @param {boolean} [options.dryrun=false] - If true, the cleanup process will only log actions without making changes.
 * @returns {Promise<boolean>} - Returns `true` if any interfaces were cleaned up, otherwise `false`.
 */
export async function clean_up_tpn_interfaces( { interfaces, ip_addresses, dryrun=false }={} ) {

    log.info( `Cleaning up ${ interfaces?.length || 'all' } interfaces` )

    // Get all interfaces
    if( !interfaces && !ip_addresses ) {
        log.info( `No interfaces provided, getting all interfaces` )
        const { stdout } = await run( `ip link show` )
        interfaces = stdout?.split( '\n' ).filter( line => line.includes( 'tpn' ) ).map( line => line.split( ':' )[ 1 ].trim() )   
        log.debug( `Found TPN interfaces:`, interfaces )
    }

    // Get all interfaces associated with the ip addresses
    if( ip_addresses ) {
        log.info( `Getting all interfaces associated with ip addresses:`, ip_addresses )
        let interfaces_of_ips = await Promise.all( ip_addresses.map( async ip => {
            ip = sanetise_ipv4( { ip } )
            const { stdout } = await run( `ip addr show | grep ${ ip } | awk -F' ' '{print $2}'` )
            const trimmed = stdout?.trim()
            if( trimmed?.includes( 'tpn' ) ) return trimmed
            return null
        } ) )
        // Filter out null values
        interfaces_of_ips = interfaces_of_ips.filter( iface => iface !== null )
        log.debug( `Found interfaces associated with ip addresses:`, interfaces_of_ips )
        interfaces = interfaces ? [ ...interfaces, ...interfaces_of_ips ] : interfaces_of_ips
    }

    // If no interfaces found, return
    if( !interfaces || !interfaces?.length ) {
        log.info( `No interfaces found to clean up` )
        return false
    }

    // Loop over interfaces and delete them, their routing tables, and their config file
    log.info( `Deleting ${ interfaces?.length } interfaces` )
    for( const interface_id of interfaces ) {
        if( dryrun ) {
            log.info( `Dryrun enabled, not deleting interface ${ interface_id }` )
            continue
        }
        log.debug( `Cleaning up interface ${ interface_id } link, route, config` )
        await run( `ip link delete ${ interface_id }`, { silent: true } )
        await run( `ip route flush table ${ interface_id }`, { silent: true } )
        await run( `rm -f ${ tmp_folder }/${ interface_id }.conf`,  { silent: true } )
        log.debug( `Deleted interface ${ interface_id } and all associated entries` )
    }

    return !!interfaces?.length

}

/**
 * Validate and reformat a wireguard config
 * @param {Object} params - Parameters for the wireguard config.
 * @param {string} params.wireguard_config - The wireguard configuration to sanitise.
 * @param {string} params.expected_endpoint_ip - The expected IP address of the endpoint.
 * @returns {Object<{ json_config: Object, text_config: string, valid: boolean, misconfigured_keys: Array, endpoint_ipv4: string }>} - The sanitised wireguard config.
 */
export function parse_wireguard_config( { wireguard_config, expected_endpoint_ip } ) {
    try {

        // Input validations
        if( typeof wireguard_config !== 'string' ) {
            log.debug( `Invalid wireguard_config:`, wireguard_config )
            throw new Error( `Wireguard config was ${ typeof wireguard_config }` )
        }

        // Trim whitespaces that would mess with our matching
        wireguard_config = multiline_trim( wireguard_config )

        // Set allowed config props
        const allowed_config_props = [
            { type: 'interface', key: 'Address', validate: is_ipv4 },
            { type: 'interface', key: 'PrivateKey', validate: value => /^[A-Za-z0-9+/=]+$/.test( value ) },
            { type: 'interface', key: 'ListenPort', validate: value => /^\d+$/.test( value ) },
            { type: 'interface', key: 'DNS', validate: is_ipv4 },
            { type: 'peer', key: 'PublicKey', validate: value => /^[A-Za-z0-9+/=]+$/.test( value ) },
            { type: 'peer', key: 'PresharedKey', validate: value => /^[A-Za-z0-9+/=]+$/.test( value ) },
            { type: 'peer', key: 'AllowedIPs', validate: value => [ '0.0.0.0/0', '0.0.0.0/0, ::/0' ].includes( value ) },
            { type: 'peer', key: 'Endpoint', validate: value => is_ipv4( `${ value }`.split( ':' )[ 0 ] ) }
        ]

        // Create config object
        let json_config = allowed_config_props.reduce( ( acc, { type, key } ) => {

            // Get key value from the config
            const key_match = new RegExp( `^${ key } ?= ?(.*)`, 'm' )
            const { 0: match, 1: value } = wireguard_config.match( key_match ) || []
            if( !match && CI_MODE === 'true' ) log.info( `Missing key ${ key } in wireguard config: `, wireguard_config )

            // add key value to the config object
            if( value ) acc[ type ][ key ] = value

            return acc

        }, { interface: {}, peer: {} } )
        if( CI_MODE === 'true' ) log.info( `Parsed wireguard config:`, {
            wireguard_config,
            json_config
        } )

        // Check if all properties are valid
        const misconfigured_keys = allowed_config_props.filter( ( { type, key, validate } ) => {
            const value = json_config[ type ][ key ]
            if( !value ) return false
            // log.info( `Checking ${ type } ${ key }: `, value )
            const is_valid = !validate || validate( value )
            return !is_valid
        } ).map( k => `${ k.type }.${ k.key } = ${ json_config[ k.type ][ k.key ] }` )

        // If the address is not in CIDR notation, add /32
        if( !json_config.interface.Address?.includes( '/' ) ) {
            log.debug( `Address ${ json_config.interface.Address } is not in CIDR notation, adding /32` )
            json_config.interface.Address = `${ json_config.interface.Address }/32`
        }

        // Explicit checks for value requirements
        const ip = json_config.peer.Endpoint?.split( ':' )[ 0 ]
        if( !ip ) log.warn( `No valid IP found in Endpoint:`, json_config )
        const endpoint_ipv4 = sanetise_ipv4( { ip, validate: true, error_on_invalid: false } )
        log.debug( `Extracted ipv4 from Endpoint: `, endpoint_ipv4 )
        const endpoint_correct = expected_endpoint_ip ? endpoint_ipv4 === expected_endpoint_ip : true
        const config_valid = !misconfigured_keys.length && endpoint_correct

        // Recreate wireguard text config
        let text_config = multiline_trim( `
        [Interface]
        Address = ${ json_config.interface.Address }
        PrivateKey = ${ json_config.interface.PrivateKey }
        ListenPort = ${ json_config.interface.ListenPort }
        DNS = ${ json_config.interface.DNS }

        [Peer]
        PublicKey = ${ json_config.peer.PublicKey }
        PresharedKey = ${ json_config.peer.PresharedKey }
        AllowedIPs = ${ json_config.peer.AllowedIPs }
        Endpoint = ${ json_config.peer.Endpoint }
    ` )

        // If the config is not valid, do not return the config text and json as a safety measure
        if( !config_valid ) {
            log.warn( `WireGuard config is not valid: `, misconfigured_keys )
            text_config = null
            json_config = null
        }

        // Return details
        return {
            json_config,
            text_config,
            config_valid,
            misconfigured_keys,
            endpoint_ipv4
        }

    } catch ( e ) {
        log.debug( `Error parsing wireguard config: `, e )
        return { config_valid: false, error: e.message }
    }
}

/**
 * 
 * @param {Object} params
 * @param {string} params.wireguard_config - The wireguard configuration to test.
 * @param {boolean} params.verbose - Whether to log verbosely.
 * @returns {Promise<{ valid: boolean, message: string }>} - The result of the wireguard connection test.
 */
export async function test_wireguard_connection( { wireguard_config, verbose=CI_MODE === 'true' } ) {

    // Check if we should mock
    const { CI_MOCK_WORKER_RESPONSES } = process.env
    if( CI_MOCK_WORKER_RESPONSES === 'true' ) {
        log.info( `CI_MOCK_WORKER_RESPONSES is enabled, returning mock response for wireguard test` )
        return { valid: true, message: "Mock response" }
    }

    // Get text config from wireguard config
    const { text_config, json_config, endpoint_ipv4 } = parse_wireguard_config( { wireguard_config } )
    const server_id = `${ random_number_between( 10, 20 ) }${ endpoint_ipv4.replaceAll( '.', '' ) }`
    const log_tag = server_id

    // Generate a challenge for the wireguard server to solve
    const tag = `wireguard_${ endpoint_ipv4 }`
    const { challenge_url, solution: correct_solution } = await generate_challenge( { tag } )

    // Get relevant interfaces
    const { interface_id, veth_id, namespace_id, veth_subnet_prefix, uplink_interface, clear_interfaces } = await get_free_interfaces( { log_tag } )
    const { Address, Endpoint } = json_config.interface

    // Path for the WireGuard configuration file.
    const tmp_config_path = `${ tmp_folder }/${ server_id }.conf`
    const wg_config_path = `${ tmp_folder }/wg_${ server_id }.conf`

    // Write the config file and set permissions.
    const write_config_command = `
        # Write the WireGuard config to a temporary file
        echo "Writing WireGuard config to ${ tmp_config_path } and ${ wg_config_path }" && \
        printf "%s" "${ text_config }" > ${ tmp_config_path } && \
        chmod 644 ${ tmp_config_path } && \
        ls -lah ${ tmp_config_path } && \
        wg-quick strip ${ tmp_config_path } > ${ wg_config_path } && \
        chmod 644 ${ wg_config_path }
        # Log the config files
        ls -lah ${ tmp_folder }/ && \
        tail -n +1 -v ${ tmp_config_path } && \
        tail -n +1 -v ${ wg_config_path }
    `

    // Set up network namespace and WireGuard interface.
    const network_setup_command = `

        # Check current ip
        curl -m 5 -s icanhazip.com

        # Add namespace
        ip netns add ${ namespace_id }
        ip netns list

        # Create loopback interface
        ip -n ${ namespace_id } link set lo up

        # Create wireguard interface and move it to namespace
        ip -n ${ namespace_id } link add ${ interface_id } type wireguard
        # ip link set ${ interface_id } netns ${ namespace_id } # alternate way to do the above

        # veth pairing of the isolated interface
        ip link add veth${ veth_id }n type veth peer name veth${ veth_id }h
        ip link set veth${ veth_id }n netns ${ namespace_id }

        # host side veth cofig
        ip addr add ${ veth_subnet_prefix }.1/24 dev veth${ veth_id }h
        ip link set veth${ veth_id }h up
        
        # namespace side veth config
        ip -n ${ namespace_id } addr add ${ veth_subnet_prefix }.2/24 dev veth${ veth_id }n
        ip -n ${ namespace_id } link set veth${ veth_id }n up

        # enable iptables nat
        sysctl -w net.ipv4.ip_forward=1
        iptables -t nat -A POSTROUTING -s ${ veth_subnet_prefix }.0/24 -o ${ uplink_interface } -j MASQUERADE
        iptables -A FORWARD -i veth${ veth_id }h -o ${ uplink_interface } -s ${ veth_subnet_prefix }.0/24 -j ACCEPT
        iptables -A FORWARD -o veth${ veth_id }h -m state --state ESTABLISHED,RELATED -j ACCEPT

        # Before setting things, check properties and routes of the interface
        ip -n ${ namespace_id } addr
        ip -n ${ namespace_id } link show ${ interface_id }
        ip -n ${ namespace_id } route show

        # Apply wireguard config to interface
        ip netns exec ${ namespace_id } wg setconf ${ interface_id } ${ wg_config_path }
        ip netns exec ${ namespace_id } wg showconf ${ interface_id }

        # Pre routing, check what addresses are inside the namespace
        ip -n ${ namespace_id } addr

        # Add routing table
        ip -n ${ namespace_id } a add ${ Address } dev ${ interface_id }
        ip -n ${ namespace_id } link set ${ interface_id } up
        ip -n ${ namespace_id } route add default dev ${ interface_id }

        # give wg endpoint exception to default route
        ip -n ${ namespace_id } route add ${ endpoint_ipv4 }/32 via ${ veth_subnet_prefix }.1

        # Add DNS
        mkdir -p /etc/netns/${ namespace_id }/ && echo "nameserver 1.1.1.1" > /etc/netns/${ namespace_id }/resolv.conf

        # Quick DNS and ping sanity checks over namespace with 1 second timeout
        # ip netns exec ${ namespace_id } ping -c 1 -W 1 1.1.1.1
        # ip netns exec ${ namespace_id } ping -c 1 -W 1 ${ endpoint_ipv4 }
        # ip netns exec ${ namespace_id } dig +time=1 +short google.com

        # Check ip address
        curl -m 5 -s icanhazip.com && ip netns exec ${ namespace_id } curl -m 5 -s icanhazip.com

    `


    // Command to test connectivity via WireGuard.
    const curl_command = `ip netns exec ${ namespace_id } curl -m ${ test_timeout_seconds } -s ${ challenge_url }`

    // Cleanup commands for the namespace and interfaces.
    const cleanup_command = `
        ip link del veth${ veth_id }h || echo "Veth ${ veth_id }h does not exist"
        ip link del veth${ veth_id }n || echo "Veth ${ veth_id }n does not exist"
        ip link del ${ interface_id } || echo "Interface ${ interface_id } does not exist"
        ip netns del ${ namespace_id } || echo "Namespace ${ namespace_id } does not exist"
        iptables -t nat -D POSTROUTING -s ${ veth_subnet_prefix }.0/24 -o eth0 -j MASQUERADE || echo "iptables rule does not exist"
        iptables -D FORWARD -i veth${ veth_id }h -o ${ uplink_interface } -s ${ veth_subnet_prefix }.0/24 -j ACCEPT || echo "iptables rule does not exist"
        iptables -D FORWARD -o veth${ veth_id }h -m state --state ESTABLISHED,RELATED -j ACCEPT || echo "iptables rule does not exist"
        rm -f ${ tmp_config_path } || echo "Config file ${ tmp_config_path } does not exist"
        rm -f ${ wg_config_path } || echo "Config file ${ wg_config_path } does not exist"
    `


    // Formulate required functions
    const run_cleanup = async ( { silent=false }={} ) => {

        // loop over cleanup commands
        const cleanup_commands = split_ml_commands( cleanup_command )
        for( const command of cleanup_commands ) {
            await run( command, { silent, log_tag } )
        }

    }
    const run_test = async () => {

        // Check for ip address conflicts
        const timeout = test_timeout_seconds * 5 // How many ip addresses to assume in the worst of circumstances to take their max timeout
        const ip_free = await wait_for_ip_free( { ip_address: Address, timeout, log_tag } )
        if( !ip_free ) {
            const ip_cleared = await clean_up_tpn_interfaces( { ip_addresses: [ Address ] } )
            if( !ip_cleared ) throw new Error( `IP address ${ Address } is still in use after cleanup` )
            log.info( `${ log_tag } IP address ${ Address } is free after cleanup` )
        }

        // Mark the ip address as in processing
        cache( `ip_being_processed_${ Address }`, true, timeout * 1000 )
        log.debug( `${ log_tag } Marking ip address ${ Address } as in processing` )

        // Write the wireguard config to a file
        const config_cmd = await run( write_config_command, { silent: !verbose, log_tag, verbose } )
        if( config_cmd.error || config_cmd.stderr ) throw new Error( `Error writing wireguard config: err ${ config_cmd.error } stderr ${ config_cmd.stderr } stdout ${ config_cmd.stdout }` )

        // loop over network commands
        const network_setup_commands = split_ml_commands( network_setup_command )

        for( const command of network_setup_commands ) {
            await run( command, { silent: !verbose, verbose: false, log_tag } )
        }
    
        // Run the curl command
        const { error, stderr, stdout } = await run( curl_command, { silent: !verbose, verbose, log_tag } )
        if( error || stderr ) {
            log.debug( `${ log_tag } Error running curl command:`, error, stderr )
            return false
        }
        
        // Isolate the json
        const [ json ] = stdout?.match( /{.*}/s ) || []
        if( !json ) {
            log.warn( `${ log_tag } No JSON response found in stdout:`, stdout )
            return false
        }

        // Return the json response
        log.debug( `${ log_tag } Wireguard config for server ${ server_id } responded with:`, json )
        return json

    } 

    // Open the challenge url using the wireguard config
    try {

        // Do pre-emptive cleanup in case a previous run messed up
        log.debug( `\n ${ log_tag } 🧹 Running pre-cleanup commands for server ${ server_id }` )
        await run_cleanup( { silent: true, log_tag } )

        // Solve the challenge from the miner ip
        log.debug( `\n ${ log_tag } 🔎 Running test commands for server ${ server_id }` )
        const stdout = await run_test()

        // Run cleanup command
        log.debug( `\n ${ log_tag } 🧹  Running cleanup commands for server ${ server_id }` )
        await run_cleanup( { silent: !verbose, log_tag } )

        // On failure to get response, error out to catch block
        if( !stdout ) throw new Error( `No response from wireguard server at ${ endpoint_ipv4 }` )

        // Extract the challenge and response from the stdout
        let [ json_response ] = stdout?.match( /{.*}/s ) || []
        if( !json_response ) {
            log.warn( `${ log_tag } No JSON response found in stdout:`, stdout )
            return { valid: false, message: `No JSON response found in stdout` }
        }
        const { solution: responded_solution } = JSON.parse( json_response )

        // Check that the wg server gave the correct solution
        const correct = correct_solution == responded_solution

        // Check that the response is valid
        if( !correct ) throw new Error( `Incorrect solution from wireguard server at ${ endpoint_ipv4 }, expected ${ correct_solution }, got ${ responded_solution }` )

        // If the response is valid, return true
        log.info( `${ log_tag } Wireguard config passed for endpoint ${ endpoint_ipv4 }` )
        return { valid: true, message: `Wireguard config passed for endpoint ${ endpoint_ipv4 } with response ${ responded_solution }` }

    } catch ( e ) {

        log.debug( `${ log_tag } Error validating wireguard config for endpoint ${ endpoint_ipv4 }:`, e )
        await run_cleanup( { silent: true, log_tag } )
        return { valid: false, message: `Error validating wireguard config for endpoint ${ endpoint_ipv4 }: ${ e.message }` }

    } finally {

        // Mark ids and ip as free again
        clear_interfaces()

    }

}
