import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { log } from 'mentie'

const { LEASE_TOKEN_SECRET } = process.env

// Fall back to random per-process secret when env var is not set
const secret = LEASE_TOKEN_SECRET || randomBytes( 32 ).toString( `hex` )

/**
 * Signs a lease token payload into a base64url-encoded opaque string.
 * The token encodes both the lease identity and routing info so the
 * validator can reconstruct the full chain on extension without any DB lookup.
 * @param {Object} payload
 * @param {string|number} payload.config_ref - The lease reference (peer_id or socks5 username)
 * @param {string} payload.type - Lease type ('wireguard' or 'socks5')
 * @param {string} payload.worker_ip - IP address of the worker holding the lease
 * @param {string} payload.mining_pool_url - URL of the mining pool that routed the original request
 * @param {string} payload.mining_pool_uid - UID of the mining pool
 * @param {number} payload.expires_at - Lease expiration timestamp (used as reallocation guard)
 * @returns {string} Base64url-encoded signed token
 */
export function sign_lease_token( { config_ref, type, worker_ip, mining_pool_url, mining_pool_uid, expires_at } ) {

    // Encode the payload as JSON then base64url
    const payload = JSON.stringify( { config_ref, type, worker_ip, mining_pool_url, mining_pool_uid, expires_at } )
    const payload_b64 = Buffer.from( payload ).toString( `base64url` )

    // HMAC-SHA256 signature over the payload
    const signature = createHmac( `sha256`, secret ).update( payload_b64 ).digest( `base64url` )

    log.debug( `Signed lease token for config_ref=${ config_ref } type=${ type } worker=${ worker_ip }` )
    return `${ payload_b64 }.${ signature }`

}

/**
 * Verifies and decodes a signed lease token.
 * Uses timing-safe comparison to prevent side-channel attacks.
 * @param {string} token - The base64url-encoded signed token from `sign_lease_token`
 * @throws {Error} If the token is malformed or the signature is invalid
 * @returns {Object} The decoded payload: { config_ref, type, worker_ip, mining_pool_url, mining_pool_uid, expires_at }
 */
export function verify_lease_token( token ) {

    if( !token || typeof token !== `string` ) throw new Error( `Invalid lease token: missing or not a string` )

    // Split into payload and signature parts
    const dot_index = token.lastIndexOf( `.` )
    if( dot_index === -1 ) throw new Error( `Invalid lease token: missing signature separator` )

    const payload_b64 = token.slice( 0, dot_index )
    const provided_sig = token.slice( dot_index + 1 )

    // Recompute HMAC and compare with timing-safe equality
    const expected_sig = createHmac( `sha256`, secret ).update( payload_b64 ).digest( `base64url` )

    const sig_buf = Buffer.from( provided_sig, `base64url` )
    const expected_buf = Buffer.from( expected_sig, `base64url` )

    if( sig_buf.length !== expected_buf.length || !timingSafeEqual( sig_buf, expected_buf ) ) {
        throw new Error( `Invalid lease token: signature mismatch` )
    }

    // Decode and parse the payload
    const payload = JSON.parse( Buffer.from( payload_b64, `base64url` ).toString( `utf-8` ) )

    log.debug( `Verified lease token for config_ref=${ payload.config_ref } type=${ payload.type }` )
    return payload

}
