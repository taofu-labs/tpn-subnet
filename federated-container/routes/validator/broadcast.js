import { Router } from 'express'
import { log, make_retryable, sanetise_ipv4, sanetise_string } from 'mentie'
import { cooldown_in_s, retry_times } from "../../modules/networking/routing.js"
import { annotate_worker_with_defaults, is_valid_worker } from '../../modules/validations.js'
import { write_workers } from '../../modules/database/workers.js'
import { is_miner_request } from '../../modules/networking/miners.js'
import { write_mining_pool_metadata } from '../../modules/database/mining_pools.js'
import { map_ips_to_geodata } from '../../modules/geolocation/ip_mapping.js'
import { resolve_domain_to_ip } from '../../modules/networking/network.js'
import { ip_geodata } from '../../modules/geolocation/helpers.js'
const { CI_MODE } = process.env

export const router = Router()

/**
 * Handle the submission of worker lists from mining pools
 * @params {Object} req.body.workers - Array of worker objects with properties: ip, country_code
 */
router.post( '/workers', async ( req, res ) => {

    // This endpoint is only for miners
    const { uid: mining_pool_uid, ip: mining_pool_ip } = await is_miner_request( req )
    if( !mining_pool_uid ) return res.status( 403 ).json( { error: `Requester ${ mining_pool_ip } not a known miner` } )

    const handle_route = async () => {

        // Get workers from the request
        let { workers=[] } = req.body || {}

        // Ensure workers is an array
        if( !Array.isArray( workers ) ) throw new Error( `Invalid workers format, must be an array` )
        log.info( `Received ${ workers.length } workers from mining pool ${ mining_pool_uid }@${ mining_pool_ip }, example: `, workers[0] )

        // Check that the claimed countries and datacenter status are valid according to our db
        const workers_geo = await Promise.all( workers.map( async ( { ip } ) => {
            const { country_code, connection_type, datacenter } = await ip_geodata( ip )
            return { ip, country_code, connection_type, datacenter }
        } ) )

        // Overwrite the claimed country codes and track mismatches
        const geo_mismatches = []
        workers = workers.map( ( worker ) => {

            // Check is claimed data matches ours
            const geo = workers_geo.find( g => g.ip === worker.ip )
            if( !geo ) return worker
            const country_matches = worker.country_code == geo.country_code
            const connection_type_matches = worker.connection_type == geo.connection_type

            // On match, keep
            if( connection_type_matches && country_matches ) return worker

            // On mismatch, log and overwrite
            geo_mismatches.push( { worker, geo } )
            return { ...worker, ...geo }

        } )

        // Clean up the worker data
        workers = workers.reduce( ( acc, worker ) => {

            // Skip invalid
            worker = annotate_worker_with_defaults( worker )
            if( !is_valid_worker( worker ) ) return acc
            
            // Sanetise the IP address
            let { ip, country_code } = worker || {}
            ip = sanetise_ipv4( { ip, validate: true } )
            acc.push( { ...worker, ip, country_code } )

            // Force override the minining pool uid to the one we know to be real
            worker.mining_pool_uid = mining_pool_uid

            return acc

        }, [] )
        log.info( `Sanetised worker data, ${ workers.length } valid entries, example: `, workers[0] )

        // Save worker ips to cache
        const ips = workers.map( worker => worker.ip )
        await map_ips_to_geodata( { ips, cache_prefix: `worker_`, prefix_merge: true } )

        // Save workers to database
        const write_result = await write_workers( { workers, mining_pool_uid, is_miner_broadcast: true } )
        return { ...write_result, mining_pool_uid, mining_pool_ip }

    }

    try {

        const retryable_handler = await make_retryable( handle_route, { retry_times, cooldown_in_s } )
        const response_data = await retryable_handler()
        return res.json( response_data )

    } catch ( e ) {
        
        log.warn( `Error handling worker broadcast. Error:`, e )
        return res.status( 200 ).json( { error: e.message, workers: req?.body?.workers } )

    }
} )


/**
 * Handle the submission of mining pool metadata from miners themselves
 * Expected body: { protocol: 'http'|'https', url: String, port: Number }
 */
router.post( '/mining_pool', async ( req, res ) => {

    // This endpoint is only for miners
    const { uid: mining_pool_uid, ip: mining_pool_ip } = await is_miner_request( req )
    if( !mining_pool_uid ) return res.status( 403 ).json( { error: `Requester ${ mining_pool_ip } not a known miner` } )

    const handle_route = async () => {

        // Extract and sanitise inputs
        let { protocol, url, port } = req.body || {}
        log.info( `Received mining pool metadata from miner ${ mining_pool_uid }@${ mining_pool_ip }:`, { protocol, url, port } )

        // Fix misconfigurations
        url = url?.replace( 'http://http://', 'http://' )?.replace( 'https://https://', 'https://' )

        // Normalise
        protocol = sanetise_string( protocol )
        url = sanetise_string( url )
        port = Number( port )
        log.info( `Sanetised mining pool metadata:`, { protocol, url, port } )

        // Validate inputs
        if( !`${ protocol }`.match( /^https?/ ) ) throw new Error( `Invalid protocol: ${ protocol }` )

        // Validate port
        if( !Number.isInteger( port ) || port < 1 || port > 65535 ) throw new Error( `Invalid port: ${ port }` )

        // Check that url resolved to the correct miner ip
        const { ip } = await resolve_domain_to_ip( { domain: url } )
        if( CI_MODE !== 'true' && ip !== mining_pool_ip ) throw new Error( `Domain ${ url } does not resolve to metagraph ip address`  )

        // Save mining pool metadata
        await write_mining_pool_metadata( { mining_pool_uid, mining_pool_ip, protocol, url, port } )

        return { success: true, mining_pool_uid, mining_pool_ip }

    }

    try {

        const retryable_handler = await make_retryable( handle_route, { retry_times, cooldown_in_s } )
        const response_data = await retryable_handler()
        return res.json( response_data )

    } catch ( e ) {
        log.warn( `Error handling mining_pool broadcast. Error:`, e )
        return res.status( 200 ).json( { error: e.message } )
    }
} )

