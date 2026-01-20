import { log, sanetise_ipv4 } from "mentie"
import { run } from "../system/shell.js"
import { run_mode } from "../validations.js"


/**
 * 
 * @param {Object} params
 * @param {string} params.sock - SOCKS5 proxy string (e.g., socks5://user:pass@ip:port)
 * @returns {Promise<boolean>} - True if the SOCKS5 connection is working, false otherwise.
 */
export async function test_socks5_connection( { sock } ) {

    try {

        // Check that the sock parameter is provided
        if( !sock || !sock.length ) throw new Error( `No sock parameter provided for SOCKS5 test` )

        // Build the curl commands
        const ip_host = `https://ipv4.icanhazip.com/`
        const curl_icanhaz = `curl -m 2 -s ${ ip_host }`
        const curl_socks5 = `curl -m 2 -s -x ${ sock } ${ ip_host }`
        log.debug( `Testing SOCKS5 connection using curl commands:`, { curl_icanhaz, curl_socks5 } )

        // Test ips
        let { stdout: direct_ip, stderr: direct_err } = await run( curl_icanhaz )
        let { stdout: socks5_ip, stderr: socks5_err } = await run( curl_socks5 )

        // Sanetise
        direct_ip = direct_ip && sanetise_ipv4( { ip: direct_ip } )
        socks5_ip = socks5_ip && sanetise_ipv4( { ip: socks5_ip } )
        log.debug( `Direct IP: ${ direct_ip }, SOCKS5 IP: ${ socks5_ip }. Errors: direct_err=${ direct_err }, socks5_err=${ socks5_err }` )

        // Compare
        const { worker_mode } = run_mode()
        let is_working = direct_ip && socks5_ip

        // For worker expect same ip
        if( is_working && worker_mode ) is_working = direct_ip == socks5_ip
        // For non-worker expect different ip
        else if( is_working && !worker_mode ) is_working = direct_ip != socks5_ip

        if( !is_working ) {
            log.info( `SOCKS5 proxy test failed: direct IP (${ direct_ip }) vs SOCKS5 IP (${ socks5_ip })` )
            log.debug( `SOCKS5 proxy test details:`, { curl_icanhaz, curl_socks5, direct_err, socks5_err } )
        }
        return is_working

    } catch ( e ) {
        log.error( `Error testing SOCKS5 connection:`, e )
        return false
    }

}