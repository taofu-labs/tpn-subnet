import { log, sanetise_ipv4 } from "mentie"
import { run_safe } from "../system/shell.js"
import { run_mode } from "../validations.js"
import { evaluate_egress_identity } from "./egress_identity.js"

const ip_host = `https://ipv4.icanhazip.com/`
const timeout_per_req = 2
const retry_time_budget = 6
const max_retries = Math.floor( retry_time_budget / timeout_per_req )
const curl_base_args = [
    `--max-time`, `${ timeout_per_req }`,
    `--silent`,
    `--retry`, `${ max_retries }`,
    `--retry-max-time`, `${ retry_time_budget }`,
    `--retry-delay`, `1`,
    `--retry-connrefused`,
    `--retry-all-errors`
]

/**
 * Builds an HTTP proxy JSON config from a SOCKS5 lease config and an advertised HTTP proxy port.
 * @param {Object} params
 * @param {string|Object} params.socks5_config - SOCKS5 config as text or JSON.
 * @param {number|string} params.http_proxy_port - Advertised HTTP proxy port.
 * @returns {{ username: string, password: string, ip_address: string, port: number, protocol: string }|null} HTTP proxy config, or null when the config cannot be parsed.
 */
export function http_proxy_config_from_socks5_config( { socks5_config, http_proxy_port } ) {

    try {

        const proxy_port = Number( http_proxy_port )
        if( !Number.isInteger( proxy_port ) || proxy_port < 1 || proxy_port > 65535 ) return null

        const has_json_config = typeof socks5_config === `object` && socks5_config
        if( has_json_config && !socks5_config.ip_address ) return null

        const socks5_url = has_json_config
            ? new URL( `socks5://${ socks5_config.ip_address }:${ socks5_config.port || 1080 }` )
            : new URL( `${ socks5_config || '' }` )

        const username = has_json_config ? socks5_config.username : socks5_url.username
        const password = has_json_config ? socks5_config.password : socks5_url.password
        if( !username || !password || !socks5_url.hostname ) return null

        return {
            username,
            password,
            ip_address: socks5_url.hostname,
            port: proxy_port,
            protocol: `http`
        }

    } catch {
        return null
    }

}

/**
 * Builds an HTTP proxy URL from a SOCKS5 lease config and an advertised HTTP proxy port.
 * @param {Object} params
 * @param {string|Object} params.socks5_config - SOCKS5 config as text or JSON.
 * @param {number|string} params.http_proxy_port - Advertised HTTP proxy port.
 * @returns {string|null} HTTP proxy URL, or null when the config cannot be parsed.
 */
export function http_proxy_from_socks5_config( { socks5_config, http_proxy_port } ) {

    try {

        const http_proxy_config = http_proxy_config_from_socks5_config( { socks5_config, http_proxy_port } )
        if( !http_proxy_config ) return null

        const http_proxy_url = new URL( `http://${ http_proxy_config.ip_address }:${ http_proxy_config.port }` )
        http_proxy_url.username = http_proxy_config.username
        http_proxy_url.password = http_proxy_config.password

        return http_proxy_url.href.replace( /\/$/, `` )

    } catch {
        return null
    }

}

/**
 * Tests an HTTP proxy and optionally verifies egress identity.
 * @param {Object} params
 * @param {string} params.proxy - HTTP proxy string (e.g., http://user:pass@ip:3128).
 * @param {string} [params.claimed_worker_ip] - Claimed worker IP to verify against observed HTTP proxy egress.
 * @returns {Promise<{
 *   valid: boolean,
 *   failure_code?: string,
 *   observed_http_proxy_ip?: string,
 *   claimed_worker_ip?: string,
 *   message?: string
 * }>} Structured HTTP proxy validation result.
 */
export async function test_http_proxy_connection( { proxy, claimed_worker_ip } ) {

    try {

        if( !proxy || !proxy.length ) {
            return {
                valid: false,
                failure_code: 'http_proxy_url_build_failure',
                message: `HTTP proxy URL could not be built`
            }
        }

        const has_claimed_worker_ip = !!`${ claimed_worker_ip || '' }`.trim()
        const curl_http_proxy_args = [ ...curl_base_args, `-x`, proxy, ip_host ]
        log.debug( `Testing HTTP proxy connection using curl args:`, { curl_http_proxy_args } )

        let { stdout: http_proxy_ip, stderr: http_proxy_err } = await run_safe( `curl`, curl_http_proxy_args )
        http_proxy_ip = http_proxy_ip && sanetise_ipv4( { ip: http_proxy_ip } )
        log.debug( `HTTP proxy IP: ${ http_proxy_ip }. Error: http_proxy_err=${ http_proxy_err }` )

        if( has_claimed_worker_ip ) {
            const identity = evaluate_egress_identity( {
                observed_egress_ip: http_proxy_ip,
                claimed_worker_ip,
                transport: 'http_proxy'
            } )
            if( !identity.valid ) {
                return {
                    valid: false,
                    failure_code: identity.failure_code,
                    observed_http_proxy_ip: identity.observed_egress_ip,
                    claimed_worker_ip: identity.claimed_worker_ip,
                    message: identity.message
                }
            }
            return {
                valid: true,
                observed_http_proxy_ip: identity.observed_egress_ip,
                claimed_worker_ip: identity.claimed_worker_ip,
                message: `HTTP proxy egress identity verified`
            }
        }

        const curl_direct_args = [ ...curl_base_args, ip_host ]
        log.debug( `Testing direct connection using curl args:`, { curl_direct_args } )
        let { stdout: direct_ip, stderr: direct_err } = await run_safe( `curl`, curl_direct_args )
        direct_ip = direct_ip && sanetise_ipv4( { ip: direct_ip } )
        log.debug( `Direct IP: ${ direct_ip }. Error: direct_err=${ direct_err }` )

        const { worker_mode } = run_mode()
        let is_working = direct_ip && http_proxy_ip

        if( is_working && worker_mode ) is_working = direct_ip == http_proxy_ip
        else if( is_working && !worker_mode ) is_working = direct_ip != http_proxy_ip

        if( !is_working ) {
            log.info( `HTTP proxy test failed: direct IP (${ direct_ip }) vs HTTP proxy IP (${ http_proxy_ip })` )
            log.debug( `HTTP proxy test details:`, {
                curl_direct_args,
                curl_http_proxy_args,
                direct_err,
                http_proxy_err
            } )
            return {
                valid: false,
                failure_code: 'http_proxy_connectivity_failure',
                observed_http_proxy_ip: http_proxy_ip,
                message: `HTTP proxy connectivity validation failed`
            }
        }

        return {
            valid: true,
            observed_http_proxy_ip: http_proxy_ip,
            message: `HTTP proxy connectivity validation passed`
        }

    } catch ( e ) {
        log.error( `Error testing HTTP proxy connection:`, e )
        return {
            valid: false,
            failure_code: 'http_proxy_connectivity_failure',
            message: `Error testing HTTP proxy connection: ${ e.message }`
        }
    }

}
