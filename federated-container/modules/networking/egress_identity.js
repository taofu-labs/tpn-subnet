import { sanetise_ipv4 } from "mentie"

/**
 * Evaluates if an observed egress IP matches the claimed worker identity.
 * @param {Object} params
 * @param {string} params.observed_egress_ip - Observed public egress IP from a transport probe.
 * @param {string} params.claimed_worker_ip - Claimed worker IP from registration data.
 * @param {'wireguard'|'socks5'} params.transport - Transport used to observe egress.
 * @returns {{ valid: boolean, failure_code?: string, observed_egress_ip?: string, claimed_worker_ip?: string, message?: string, transport: string }}
 */
export const evaluate_egress_identity = ( { observed_egress_ip, claimed_worker_ip, transport } ) => {

    // Sanetise ips
    const expected_ip = sanetise_ipv4( { ip: claimed_worker_ip, validate: true, error_on_invalid: false } )
    const observed_ip = sanetise_ipv4( { ip: observed_egress_ip, validate: true, error_on_invalid: false } )

    // Validate claim
    if( !expected_ip ) {
        return {
            valid: false,
            failure_code: 'invalid_claimed_worker_ip',
            claimed_worker_ip,
            observed_egress_ip: observed_ip,
            message: `Invalid claimed worker ip for ${ transport }: ${ claimed_worker_ip }`,
            transport
        }
    }

    // Validate observed value
    if( !observed_ip ) {
        return {
            valid: false,
            failure_code: 'no_egress_ip',
            claimed_worker_ip: expected_ip,
            observed_egress_ip: observed_ip,
            message: `No valid observed egress ip for ${ transport }`,
            transport
        }
    }

    // Validate identity
    const matches_claim = observed_ip === expected_ip
    if( !matches_claim ) {
        return {
            valid: false,
            failure_code: 'egress_ip_mismatch',
            claimed_worker_ip: expected_ip,
            observed_egress_ip: observed_ip,
            message: `Observed ${ transport } egress ip ${ observed_ip } does not match claimed worker ip ${ expected_ip }`,
            transport
        }
    }

    return {
        valid: true,
        claimed_worker_ip: expected_ip,
        observed_egress_ip: observed_ip,
        transport
    }

}
