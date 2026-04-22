import { log } from "mentie"
import { get_pg_pool } from "./postgres.js"
import { run_mode } from "../validations.js"

export async function database_cleanup() {

    // Time helpers
    const year_in_mins = 525600
    const month_in_mins = 43800
    const epoch_minutes = 90

    // Define tables to be cleaned up
    const { mode, validator_mode, miner_mode, worker_mode } = run_mode()

    // Table staleness definitions
    const shared_tables = [
        { table: 'timestamps', time_field: 'updated', max_stale_minutes: year_in_mins }
    ]
    const worker_tables = [
        { table: 'worker_wireguard_configs', time_field: 'expires_at', max_stale_minutes: epoch_minutes },
    ]
    const neuron_tables = [
        { table: 'workers', time_field: 'updated_at', max_stale_minutes: epoch_minutes },
        { table: 'worker_performance', time_field: 'updated_at', max_stale_minutes: year_in_mins },
        { table: 'worker_broadcast_metadata', time_field: 'updated', max_stale_minutes: epoch_minutes },
        { table: 'challenge_solution', time_field: 'updated', max_stale_minutes: epoch_minutes },
        { table: 'ip_geodata_cache', time_field: 'expires_at', max_stale_minutes: 0 },
    ]
    const validator_tables = [
        { table: 'mining_pool_metadata_broadcast', time_field: 'updated', max_stale_minutes: epoch_minutes },
        { table: 'scores', time_field: 'updated', max_stale_minutes: epoch_minutes }
    ]
    const STALENESS_THRESHOLDS = [
        ...shared_tables,
        ...worker_mode ? worker_tables : [] ,
        ...miner_mode || validator_mode ? neuron_tables : [] ,
        ...validator_mode ? validator_tables : [] 
    ]

    try {

        // Get Postgres pool
        const pool = await get_pg_pool()

        // For each table, delete stale entries
        for( const { table, max_stale_minutes, time_field } of STALENESS_THRESHOLDS ) {

            if( !table || max_stale_minutes == null || !time_field ) continue

            // Calculate threshold time
            const threshold_time = Date.now() -  max_stale_minutes * 60_000 
            log.info( `Cleaning up table ${ table } based on field ${ time_field }, removing entries older than ${ max_stale_minutes } minutes` )
            if( isNaN( threshold_time ) ) {
                log.error( `Invalid threshold time for table ${ table }, skipping cleanup` )
                continue
            }

            try {
                
                const delete_result = await pool.query( `
                    DELETE FROM ${ table }
                    WHERE ${ time_field } < $1
                `, [ threshold_time ] )

                log.info( `Deleted ${ delete_result.rowCount } stale entries from table ${ table }` )

            } catch ( e ) {
                log.error( `Error cleaning up table ${ table } on ${ mode }:`, e )
            }

        }

    } catch ( e ) {
        log.error( `Error during database cleanup:`, e )
    }

}