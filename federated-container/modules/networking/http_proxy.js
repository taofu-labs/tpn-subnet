import { log, sanetise_ipv4 } from "mentie"
import { run_safe } from "../system/shell.js"
import { run_mode } from "../validations.js"
import { evaluate_egress_identity } from "./egress_identity.js"

/**
 * Builds an HTTP proxy URL from a SOCKS5 lease config and an advertised HTTP proxy port.
 * @param {Object} params
 * @param {string|Object} params.socks5_config - SOCKS5 config as text or JSON.
 * @param {number|string} params.http_proxy_port - Advertised HTTP proxy port.
 * @returns {string|null} HTTP proxy URL, or null when the config cannot be parsed.
 */
export function http_proxy_from_socks5_config( { socks5_config, http_proxy_port } ) {

    try {

        const proxy_port = Number( http_proxy_port || 3128 )
        if( !Number.isInteger( proxy_port ) || proxy_port < 1 || proxy_port > 65535 ) return null

        const has_json_config = typeof socks5_config === `object` && socks5_config
        if( has_json_config && !socks5_config.ip_address ) return null

        const socks5_url = has_json_config
            ? new URL( `socks5://${ socks5_config.ip_address }:${ socks5_config.port || 1080 }` )
            : new URL( `${ socks5_config || '' }` )

        const username = has_json_config ? socks5_config.username : socks5_url.username
        const password = has_json_config ? socks5_config.password : socks5_url.password
        if( !username || !password || !socks5_url.hostname ) return null

        const http_proxy_url = new URL( `http://${ socks5_url.hostname }:${ proxy_port }` )
        http_proxy_url.username = username
        http_proxy_url.password = password

        return http_proxy_url.href.replace( /\/$/, '' )

    } catch {
        return null
    }

}

/**
 * Tests an HTTP CONNECT proxy and optionally verifies egress identity.
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

        if( !proxy || !proxy.length ) throw new Error( `No proxy parameter provided for HTTP proxy test` )

        // Match the SOCKS5 probe behavior so the two proxy paths are scored consistently.
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
        const curl_direct_args = [ ...curl_base_args, ip_host ]
        const curl_http_proxy_args = [ ...curl_base_args, `-x`, proxy, ip_host ]
        log.debug( `Testing HTTP proxy connection using curl args:`, { curl_direct_args, curl_http_proxy_args } )

        let { stdout: direct_ip, stderr: direct_err } = await run_safe( `curl`, curl_direct_args )
        let { stdout: http_proxy_ip, stderr: http_proxy_err } = await run_safe( `curl`, curl_http_proxy_args )

        direct_ip = direct_ip && sanetise_ipv4( { ip: direct_ip } )
        http_proxy_ip = http_proxy_ip && sanetise_ipv4( { ip: http_proxy_ip } )
        log.debug(
            `Direct IP: ${ direct_ip }, HTTP proxy IP: ${ http_proxy_ip }. Errors: direct_err=${ direct_err }, http_proxy_err=${ http_proxy_err }`
        )

        const has_claimed_worker_ip = !!`${ claimed_worker_ip || '' }`.trim()
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
