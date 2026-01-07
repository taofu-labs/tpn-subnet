import { Router } from "express"
import { is_ipv4, log, make_retryable, require_props, sanetise_ipv4 } from "mentie"
import { request_is_local } from "../../modules/networking/network.js"
import { save_tpn_cache_to_disk, set_tpn_cache } from "../../modules/caching.js"
import { validators_ip_fallback } from "../../modules/networking/validators.js"
import { cooldown_in_s, retry_times } from "../../modules/networking/routing.js"
import { map_ips_to_geodata } from "../../modules/geolocation/ip_mapping.js"
export const router = Router()

/**
 * Route to handle neuron broadcasts
 * @params {Object} req.body.neurons - Array of neuron objects with properties: uid, ip, validator_trust, alpha_stake, stake_weight, block, hotkey, coldkey
 */
router.post( "/broadcast/neurons", async ( req, res ) => {

    if( !request_is_local( req ) ) return res.status( 403 ).json( { error: `Request not from localhost` } )

    const handle_route = async () => {

        // Get neurons from the request
        const { neurons=[] } = req.body || {}

        // Validate that all properties are present
        let valid_entries = neurons.filter( entry => require_props( entry, [ 'uid', 'ip', 'validator_trust', 'alpha_stake', 'stake_weight', 'block', 'hotkey', 'coldkey' ], false ) )
        log.info( `Valid neuron entries: ${ valid_entries.length } of ${ neurons.length } ` )
        log.insane( valid_entries )

        // Sanetise the entry data
        valid_entries = valid_entries.map( entry => {
            const { uid, validator_trust, alpha_stake, stake_weight } = entry
            let { ip } = entry

            // If null ip check if we have fallback
            if( ip == '0.0.0.0' ) ip = validators_ip_fallback[ uid ]?.ip || ip
            
            return {
                uid: Number( uid ),
                ip: sanetise_ipv4( { ip, validate: true } ) || '0.0.0.0',
                validator_trust: Number( validator_trust ),
                alpha_stake: Number( alpha_stake ),
                stake_weight: Number( stake_weight )
            }
        } )

        // If there are no valid entries, throw an error
        if( valid_entries.length == 0 ) return { error: `No valid neuron entries found` }

        // Split the validators, miners, and weight copiers
        const { validators=[], miners=[], weight_copiers=[], excluded=[] } = valid_entries.reduce( ( acc, entry ) => {

            const { validator_trust=0, ip, excluded=false } = entry
            const zero_ip = ip == '0.0.0.0'
            const valid_ip = is_ipv4( ip ) && !zero_ip

            // If the entry is excluded, skip it
            if( excluded ) {
                acc.excluded.push( entry )
                return acc
            }

            // If you have validator trust, you are a validator or weight copier
            if( validator_trust > 0 ) {

                // If you have a valid ip, you are a validator
                if( valid_ip ) acc.validators.push( entry )
                // If you have no valid ip, you are a weight copier
                else acc.weight_copiers.push( entry )

                return acc
            }

            // If you have no validator trust, but a valid ip, you are a miner
            if( valid_ip ) acc.miners.push( entry )

            return acc

        }, { validators: [], miners: [], weight_copiers: [], excluded: [] } )

        log.info( `Found ${ validators.length } validators, ${ miners.length } miners, ${ excluded.length } excluded, and ${ weight_copiers.length } weight copiers` )

        // ///////////////////////////
        // 🤖 Cache validators to memory
        // ///////////////////////////
        log.insane( `Caching validator ip data: `, validators )
        set_tpn_cache( { key: `last_known_validators`, value: validators } )

        // ///////////////////////////
        // ⚒️ Cache miners to memory
        // ///////////////////////////
        log.debug( `Caching ${ miners.length } miner ip data` )
        set_tpn_cache( { key: `last_known_miners`, value: miners } )
        const ips = miners.map( miner => miner.ip )
        const ip_to_uid = valid_entries.reduce( ( acc, { ip, uid } ) => ( { ...acc, [ip]: uid } ), {} )
        const { ip_to_country, country_count, country_annotated_ips } = await map_ips_to_geodata( { ips, ip_to_uid, cache_prefix: 'miner_' } )

        // Map uid to ip
        const uid_to_ip = Object.keys( ip_to_country ).reduce( ( acc, ip ) => {
            const { uid } = ip_to_country[ ip ]
            acc[ uid ] = ip
            return acc
        }, {} )

        // For each country, list the miner uids in there
        const country_to_uids = country_annotated_ips.reduce( ( acc, { ip_address, uid, country_code } ) => {
            if( !acc[ country_code ] ) acc[ country_code ] = []
            acc[ country_code ].push( uid )
            return acc
        }, {} )

        // Make a list of miner uids
        const miner_uids = miners.map( entry => entry.uid )

        // Cache ip country data to memory
        set_tpn_cache( { key: `miner_country_count`, value: country_count } )
        set_tpn_cache( { key: `miner_uids`, value: miner_uids } )
        set_tpn_cache( { key: `miner_country_to_uids`, value: country_to_uids } )
        set_tpn_cache( { key: `miner_ip_to_uid`, value: ip_to_uid } )
        set_tpn_cache( { key: `miner_uid_to_ip`, value: uid_to_ip } )

        // Persist cache to disk
        await save_tpn_cache_to_disk()

        // Return some stats
        return {
            validators: validators.length,
            miners: miners.length,
            weight_copiers: weight_copiers.length,
            success: true,
        }

    }

    try {

        const retryable_handler = await make_retryable( handle_route, { retry_times, cooldown_in_s } )
        const response_data = await retryable_handler()
        return res.json( response_data )

    } catch ( e ) {
        
        log.warn( `Error handling neuron broadcast. Error:`, e )
        return res.status( 200 ).json( { error: e.message } )

    }

} )