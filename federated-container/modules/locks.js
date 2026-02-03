import { Mutex, withTimeout } from "async-mutex"
import { log } from "mentie"

// Valid lock names for type safety and debugging
const VALID_LOCK_NAMES = [
    `get_socks5_config`,
    `dante_refresh`,
    `score_mining_pools`,
    `score_all_known_workers`,
    `register_wireguard_lease`
]

// Registry of named mutexes
const locks = new Map()

/**
 * Gets or creates a named mutex with optional timeout
 * @param {string} name - The name of the lock (must be one of VALID_LOCK_NAMES)
 * @param {Object} options - Configuration options
 * @param {number} [options.timeout_ms] - Optional timeout in milliseconds
 * @returns {Mutex} The mutex instance
 */
export function get_lock( name, { timeout_ms } = {} ) {

    // Validate lock name
    if( !VALID_LOCK_NAMES.includes( name ) ) {
        log.warn( `Unknown lock name: ${ name }. Valid names: ${ VALID_LOCK_NAMES.join( ', ' ) }` )
    }

    // Get or create the lock
    if( !locks.has( name ) ) {
        const mutex = new Mutex()
        locks.set( name, mutex )
    }

    const mutex = locks.get( name )

    // Return mutex with timeout wrapper if specified
    if( timeout_ms ) {
        return withTimeout( mutex, timeout_ms )
    }

    return mutex

}

/**
 * Non-blocking attempt to acquire a lock
 * @param {string} name - The name of the lock
 * @returns {Promise<Function|null>} Release function if acquired, null if lock is already held
 */
export async function try_acquire_lock( name ) {

    const mutex = get_lock( name )

    // Check if lock is already held - return immediately if so
    if( mutex.isLocked() ) {
        log.debug( `Lock ${ name } is already held, returning null` )
        return null
    }

    // Acquire the lock - since we checked isLocked, this should resolve quickly
    // Note: tiny race window exists where another caller could acquire between
    // isLocked check and acquire, but that's acceptable (they'll just queue)
    const release = await mutex.acquire()

    return release

}

/**
 * Runs a function exclusively under a named lock
 * @param {string} name - The name of the lock
 * @param {Function} fn - Async function to run under the lock
 * @param {Object} options - Configuration options
 * @param {number} [options.timeout_ms] - Optional timeout in milliseconds
 * @returns {Promise<*>} Result of the function
 */
export async function with_lock( name, fn, { timeout_ms } = {} ) {

    const mutex = get_lock( name, { timeout_ms } )

    log.debug( `Acquiring lock: ${ name }` )
    const release = await mutex.acquire()

    try {
        log.debug( `Lock acquired: ${ name }` )
        return await fn()
    } finally {
        log.debug( `Releasing lock: ${ name }` )
        release()
    }

}

/**
 * Checks if a lock is currently held (for debugging)
 * @param {string} name - The name of the lock
 * @returns {boolean} True if the lock is held
 */
export function is_locked( name ) {

    if( !locks.has( name ) ) return false
    return locks.get( name ).isLocked()

}
