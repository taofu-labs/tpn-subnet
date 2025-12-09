import { Router } from "express"
import { cache, log, round_number_to_decimals } from "mentie"
import { get_tpn_cache } from "../../modules/caching.js"
import { run_mode } from "../../modules/validations.js"
import { get_worker_performance, get_workers } from "../../modules/database/workers.js"
import { writeToString } from "@fast-csv/format"

export const router = Router()


router.get( '/stats', async ( req, res ) => {

    try {

        const { mode, validator_mode } = run_mode()
        const country_count = get_tpn_cache( 'country_count' )
        const country_code_to_ips = get_tpn_cache( 'country_code_to_ips' )
        const miner_uid_to_ip = validator_mode && get_tpn_cache( 'miner_uid_to_ip' )

        return res.json( { mode, country_count, country_code_to_ips, miner_uid_to_ip } )

    } catch ( error ) {
        return res.status( 500 ).json( { error: `Error handling stats route: ${ error.message }` } )
    }
} )

router.get( '/worker_performance', async ( req, res ) => {

    try {

        // Default values
        const { history_days=7 } = req.query || {}
        const _from = Date.now() - history_days * 24 * 60 * 60_000
        const _to = Date.now()
        const _format = 'json'
        const _group_by = 'ip'

        // Conflicting params
        if( req.query?.from && req.query?.history_days ) throw new Error( `Cannot specify both 'from' and 'history_days'` )
        if( req.query?.to && req.query?.history_days ) throw new Error( `Cannot specify both 'to' and 'history_days'` )

        // Get request params
        let { from=_from, to=_to, format=_format, api_key, group_by=_group_by } = req.query || {}
        log.debug( `Worker performance request from ${ from } to ${ to } in format ${ format } with api_key ${ api_key ? 'provided' : 'not provided' }` )

        // Check request validity
        const { miner_mode } = run_mode()
        if( !miner_mode ) return res.status( 403 ).json( { error: `Performance data is only available in miner mode` } )
        const { ADMIN_API_KEY } = process.env
        if( ADMIN_API_KEY && api_key !== ADMIN_API_KEY ) return res.status( 403 ).json( { error: `Invalid API key` } )

        // If no admin API key was set, warn
        log.warn( `No ADMIN_API_KEY set in environment, this is a security risk and should be set in production` )

        // Check for response cache
        const cached_response = cache( `worker_performance_${ group_by }_${ from }_${ to }_${ format }` )
        if( cached_response ) {
            log.info( `Returning cached response for worker performance from ${ from } to ${ to } in format ${ format }` )
            if( format === 'json' ) return res.json( cached_response )
            if( format === 'csv' ) return res.type( 'text/csv' ).send( cached_response )
        }

        // If the from and to values are timestamps, type them, if strings, parse to timestamps
        if( from && isNaN( Number( from ) ) ) {
            const parsed_from = Date.parse( from )
            log.debug( `Parsed 'from' date string ${ from } to timestamp ${ parsed_from }` )
            from = parsed_from
        } else {
            from = Number( from )
        }
        if( to && isNaN( Number( to ) ) ) {
            const parsed_to = Date.parse( to )
            log.debug( `Parsed 'to' date string ${ to } to timestamp ${ parsed_to }` )
            to = parsed_to
        } else {
            to = Number( to )
        }

        // If parsing failed, return with invalid date error
        if( isNaN( from ) ) return res.status( 400 ).json( { error: `Invalid 'from' date` } )
        if( isNaN( to ) ) return res.status( 400 ).json( { error: `Invalid 'to' date` } )

        // Get the relevant worker data
        let { success, workers } = await get_worker_performance( { from, to } )
        if( !success ) throw new Error( `Error fetching worker performance data` )

        // Annotate workers with payment data
        workers = await Promise.all( workers.map( async worker => {
            const cached_metadata = cache( `worker_metadata_${ worker.ip }` )
            if( cached_metadata ) return { ...worker, ...cached_metadata }
            const { success, workers=[] } = await get_workers( { ip: worker.ip } )
            if( !success || workers.length === 0 ) return worker
            cache( `worker_metadata_${ worker.ip }`, workers?.[0], 10_000 )
            return { ...worker, ...workers[0] }
        } ) )

        // Collate data into scores
        const metadata = { from, to, from_human: from ? new Date( from ).toISOString() : 'N/A', to_human: to ? new Date( to ).toISOString() : 'N/A', total_workers: workers.length }
        const defaults = { payment_address_evm: '', payment_address_bittensor: '' }
        const totals = workers.reduce( ( acc, { status } ) => {
            acc[ status ] = ( acc[ status ] || 0 ) + 1
            return acc
        }, { up: 0, down: 0, unknown: 0 } )
        workers = workers.reduce( ( acc, { ip, status, ...worker } ) => {

            // Increment status scores
            const history = acc[ ip ] || { up: 0, down: 0, unknown: 0, uptime: 0 }
            acc[ ip ] = { ...defaults, ...history, ...metadata, ...worker, [ status ]: history[ status ] + 1 }

            // Increment worker uptime
            const { up, down, unknown } = acc[ ip ]
            const uptime = Math.round(  up / ( up + down + unknown )  * 10000 ) / 100
            acc[ ip ].uptime = isNaN( uptime ) ? 0 : uptime

            return acc

        }, {} )

        // Turn into array sorted by uptime
        workers = Object.entries( workers ).map( ( [ ip, data ] ) => ( { ip, ...data } ) ).sort( ( a, b ) => b.uptime - a.uptime )

        // Annotate workers with payment_fraction
        workers = workers.map( worker => {
            // Of the uptime, how up was this worker
            const uptime_fraction = worker.up / totals.up
            const payment_fraction = round_number_to_decimals( isNaN( uptime_fraction ) ? 0 : uptime_fraction, 4, 'down' )
            return { ...worker, payment_fraction }
        } )
        log.info( `Payment fraction annotations added, total payment fractions: ${ workers.reduce( ( acc, { payment_fraction } ) => acc + payment_fraction, 0 ) }` )

        // If group_by is not ip but wallet, map ip to wallet address
        let response_data = {}
        if( group_by == 'ip' ) response_data = workers
        if( group_by == 'payment_address_evm' ) {

            // Group by EVM address
            const data_by_evm_address = workers.reduce( ( acc, worker ) => {
                const { payment_address_evm } = worker
                if( !payment_address_evm ) return acc
                const reward_fraction = acc[ payment_address_evm ] || 0
                acc[ payment_address_evm ] = reward_fraction + worker.payment_fraction
                return acc
            }, {} )

            // Turn into array sorted by payment fraction
            response_data = Object.entries( data_by_evm_address ).map( ( [ payment_address_evm, payment_fraction ] ) => ( { payment_address_evm, payment_fraction } ) ).sort( ( a, b ) => b.payment_fraction - a.payment_fraction )

        }
        if( group_by == 'payment_address_bittensor' ) {
            
            // Group by Bittensor address
            const data_by_bittensor_address = workers.reduce( ( acc, worker ) => {
                const { payment_address_bittensor } = worker
                if( !payment_address_bittensor ) return acc
                const reward_fraction = acc[ payment_address_bittensor ] || 0
                acc[ payment_address_bittensor ] = reward_fraction + worker.payment_fraction
                return acc
            }, {} )

            // Turn into array sorted by payment fraction
            response_data = Object.entries( data_by_bittensor_address ).map( ( [ payment_address_bittensor, payment_fraction ] ) => ( { payment_address_bittensor, payment_fraction } ) ).sort( ( a, b ) => b.payment_fraction - a.payment_fraction )
            
        }

        // Cache response for 5 minutes
        cache( `worker_performance_${ group_by }_${ from }_${ to }_${ format }`, response_data, 5 * 60_000 )

        // Return in the requested format
        if( format === 'json' ) {
            return res.json( response_data )
        } else if( format === 'csv' ) {
            const csv = await writeToString( response_data, { headers: true } )
            return res.type( 'text/csv' ).send( csv )
        }

        // Fall back to json
        return res.json( response_data )

    } catch ( error ) {
        log.error( `Error in worker performance route: `, error )
        return res.status( 500 ).json( { error: `Error handling performance route: ${ error.message }` } )
    }
} )

router.get( '/request/:id', ( req, res ) => {

    try {
        const { id } = req.params || {}
        return res.json( { status: cache( `request_${ id }` ) } )
    } catch ( error ) {
        return res.status( 500 ).json( { error: `Error handling request route: ${ error.message }` } )
    }
} )