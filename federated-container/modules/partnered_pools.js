import { log } from "mentie"

const { PARTNERED_NETWORK_MINING_POOLS } = process.env

// Parse "5:1.1.1.1,10:6.4.4.1" into a Map { "5" => "1.1.1.1", "10" => "6.4.4.1" }
const partnered_pools = new Map()

if( PARTNERED_NETWORK_MINING_POOLS ) {

    PARTNERED_NETWORK_MINING_POOLS.split( ',' ).forEach( entry => {
        const [ uid, ip ] = entry.trim().split( ':' )
        if( uid && ip ) partnered_pools.set( uid.trim(), ip.trim() )
    } )

    log.info( `Loaded ${ partnered_pools.size } partnered network mining pools` )

}

/**
 * Checks whether a mining pool is in the partnered network list.
 * Both uid and ip must match the entry in PARTNERED_NETWORK_MINING_POOLS.
 * @param {Object} params
 * @param {string} params.mining_pool_uid - UID of the mining pool
 * @param {string} params.mining_pool_ip - IP address of the mining pool
 * @returns {boolean} True if the pool is partnered and uid:ip match
 */
export function is_partnered_pool( { mining_pool_uid, mining_pool_ip } ) {
    const expected_ip = partnered_pools.get( String( mining_pool_uid ) )
    return !!expected_ip && expected_ip === mining_pool_ip
}
