import { log } from "mentie"

let { SERVER_PUBLIC_URL, SERVER_PUBLIC_PORT=3000, SERVER_PUBLIC_PROTOCOL, SERVER_PUBLIC_HOST, CI_MODE } = process.env
log.info( `SERVER_PUBLIC_URL: ${ SERVER_PUBLIC_URL }` )
log.info( `SERVER_PUBLIC_PORT: ${ SERVER_PUBLIC_PORT }` )
log.info( `SERVER_PUBLIC_PROTOCOL: ${ SERVER_PUBLIC_PROTOCOL }` )
log.info( `SERVER_PUBLIC_HOST: ${ SERVER_PUBLIC_HOST }` )
if( !SERVER_PUBLIC_URL?.length ) {
    log.info( `No SERVER_PUBLIC_URL environment variable set, constructing from parts:`, {
        SERVER_PUBLIC_PROTOCOL,
        SERVER_PUBLIC_HOST,
        SERVER_PUBLIC_PORT
    } )
    SERVER_PUBLIC_URL = `${ SERVER_PUBLIC_PROTOCOL }://${ SERVER_PUBLIC_HOST }:${ SERVER_PUBLIC_PORT }`
    process.env.SERVER_PUBLIC_URL = SERVER_PUBLIC_URL
}


// Base url based on environment
let base_url = `${ SERVER_PUBLIC_URL }`.trim()

// If the base url contains a trailing port, remove it
if( base_url.match( /:\d+$/ ) ) {
    log.warn( `Base url ${ base_url } contains a port, this will be ignored` )
    base_url = base_url.replace( /:\d+$/, '' )
}

// If the base url was set to the default (faulty) value in the readme, explode
if( base_url == 'http://1.2.3.4' ) {
    log.error( `You need to set the PUBLIC_VALIDATOR_URL environment variable to your public url, it is currently http://1.2.3.4` )
    // Debounce restarts to docker doesn't have to reboot every  second
    process.exit( 1 )
}

// Remove trailing slash
base_url = `${ base_url }`.replace( /\/$/, '' )

// Check if public url has a port
const has_port = `${ base_url }`.match( /:\d+$/ )

if( has_port && SERVER_PUBLIC_PORT ) log.error( `You specified a SERVER_PUBLIC_PORT=${ SERVER_PUBLIC_PORT } but your base url ${ base_url } also has a port specified, this will break!` )

if( SERVER_PUBLIC_PORT && !base_url.includes( `:${ SERVER_PUBLIC_PORT }` ) ) {
    log.info( `Adding port ${ SERVER_PUBLIC_PORT } to base url` )
    base_url = `${ base_url }:${ SERVER_PUBLIC_PORT }`
}

export { base_url }

/**
 * Safely parses a URL string with optional decoding and query param extraction.
 * @param {Object} options
 * @param {string} options.url - The URL to parse
 * @param {string[]} [options.params] - Query param names to hoist into the result. Must not collide with URL property names (origin, pathname, host, hostname, port, protocol, hash, href).
 * @param {boolean} [options.decode] - Whether to URL-decode the input first
 * @returns {{ origin: string, pathname: string, host: string, hostname: string, port: string, protocol: string, hash: string, href: string, url: URL } | { error: string }}
 */
export const parse_url = ( { url: raw_url, params = [], decode = false } ) => {

    try {

        const url = new URL( decode ? decodeURIComponent( raw_url ) : raw_url )
        const { origin, pathname, host, hostname, port, protocol, hash, href } = url

        // Extract requested query params into the result object
        const query = Object.fromEntries( params.map( p => [ p, url.searchParams.get( p ) ] ) )

        return { origin, pathname, host, hostname, port, protocol, hash, href, ...query, url }

    } catch ( e ) {

        log.warn( `Failed to parse URL: ${ raw_url }`, e )
        return { error: e.message }

    }

}
