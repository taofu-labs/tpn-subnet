import { Router } from 'express'
import { log } from 'mentie'
import { annotate_worker_with_defaults, is_valid_worker } from '../../modules/validations.js'
import { map_ips_to_geodata } from '../../modules/geolocation/ip_mapping.js'
import { ip_geodata } from '../../modules/geolocation/helpers.js'
import { write_workers } from '../../modules/database/workers.js'
import { validate_and_annotate_workers } from '../../modules/scoring/score_workers.js'
import { ip_from_req } from '../../modules/networking/network.js'
import { is_validator_request } from '../../modules/networking/validators.js'
const { CI_MODE } = process.env

export const router = Router()

/**
 * Handle the submission of worker lists from mining pools
 * @params {Object} req.body.workers - Array of worker objects with properties: ip, country_code
 */
router.post( '/worker', async ( req, res ) => {

    try {
        
        // Get workerdata from request from the request
        const { wireguard_config, mining_pool_url, public_url, public_port, payment_address_evm, payment_address_bittensor } = req.body || {}
        const { unspoofable_ip } = ip_from_req( req )
        
        // Validate inputs
        if( !wireguard_config ) throw new Error( `Missing WireGuard configuration in request` )

        // Get worker data
        const { country_code, datacenter } = await ip_geodata( unspoofable_ip )
        let worker = { ip: unspoofable_ip, country_code, datacenter, status: 'tbd', mining_pool_url, public_url, public_port, payment_address_evm, payment_address_bittensor }
        log.info( `Received worker registration from ${ unspoofable_ip }:`, worker )
        worker = annotate_worker_with_defaults( worker )
        worker.wireguard_config = wireguard_config
        if( !is_valid_worker( worker ) ) throw new Error( `Invalid worker data received` )

        // Check that worker is valid
        if( CI_MODE === 'true' ) log.info( `Parsing worker broadcast for:`, worker )
        const { successes, failures } = await validate_and_annotate_workers( { workers_with_configs: [ worker ] } )
        if( !successes.length ) {
            log.info( `Worker failed validation`, failures )
            throw new Error( `Worker failed validation` )
        }

        // Set worker to the successful worker
        const [ successful_worker ] = successes
        if( successful_worker.ip !== worker.ip ) throw new Error( `Worker IP mismatch after validation, this should never happen` )
        worker = successful_worker

        // Cache geodata for this worker
        await map_ips_to_geodata( { ips: [ worker.ip ], cache_prefix: `worker_`, prefix_merge: true } )

        // Save worker to database
        await write_workers( { workers: [ worker ], mining_pool_uid: 'internal', mining_pool_ip: 'internal' } )

        // Resolve to success
        return res.json( { registered: true, worker } )


    } catch ( e ) {
        
        log.warn( `Error handling worker broadcast. Error:`, e )
        return res.status( 200 ).json( { error: e.message } )

    }
} )

/**
 * Receive feedback from mining pools about worker scoring
 */
router.post( '/worker/feedback', ( req, res ) => {

    // Make sure endpoint was called by validator
    const { uid, ip } =is_validator_request( req )
    if( !uid ) return res.status( 403 ).json( { error: `Forbidden, endpoint only for validators` } )
    log.info( `Received worker feedback from validator ${ uid } (${ ip })` )

    // Get the composite_scores and workers_with_status from the request body
    const { composite_scores, workers_with_status } = req.body || {}

    // Log the received feedback
    log.debug( `Received worker feedback:`, { composite_scores, workers_with_status } )

    // Respond with a success message
    return res.json( { success: true } )

} )