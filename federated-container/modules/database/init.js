import { run_mode } from "../validations.js"
import { get_pg_pool } from "./postgres.js"
import { log } from "mentie"
const { CI_MODE, FORCE_DESTROY_DATABASE } = process.env

export async function init_database() {

    const pool = await get_pg_pool()
    const { validator_mode, miner_mode, worker_mode } = run_mode()


    /* ///////////////////////////////
    // Init database
    // //////////////////////////// */

    // In dev, delete old table
    if( CI_MODE === 'true' || FORCE_DESTROY_DATABASE === 'true' ) {
        log.info( 'Dropping old tables in CI mode' )
        await pool.query( `DROP TABLE IF EXISTS workers` )
        await pool.query( `DROP TABLE IF EXISTS worker_performance` )
        await pool.query( `DROP TABLE IF EXISTS timestamps` )
        await pool.query( `DROP TABLE IF EXISTS worker_broadcast_metadata` )
        await pool.query( `DROP TABLE IF EXISTS mining_pool_metadata_broadcast` )
        await pool.query( `DROP TABLE IF EXISTS challenge_solution` )
        await pool.query( `DROP TABLE IF EXISTS scores` )
        await pool.query( `DROP TABLE IF EXISTS worker_wireguard_configs` )
        await pool.query( `DROP TABLE IF EXISTS ip_geodata_cache` )
    }

    // Enable extension that can sample rows randomly
    if( miner_mode || validator_mode ) {
        await pool.query( `CREATE EXTENSION IF NOT EXISTS tsm_system_rows` )
        log.info( `✅ tsm_system_rows extension enabled` )
    }

    // Create the WORKERS table if it doesn't exist
    if( miner_mode || validator_mode ) {
        await pool.query( `
            CREATE TABLE IF NOT EXISTS workers (
                PRIMARY KEY (mining_pool_uid, mining_pool_url, ip),
                ip TEXT,
                public_url TEXT,
                payment_address_evm TEXT,
                payment_address_bittensor TEXT,
                public_port TEXT NOT NULL,
                country_code TEXT NOT NULL,
                mining_pool_url TEXT NOT NULL,
                mining_pool_uid TEXT NOT NULL,
                status TEXT NOT NULL,
                connection_type TEXT NOT NULL,
                updated_at BIGINT NOT NULL
            )
        ` )
        log.info( `✅ Workers table initialized` )

        // Speed up country code lookups for the /api/lease/countries endpoint
        await pool.query( `CREATE INDEX IF NOT EXISTS idx_workers_status_country ON workers ( status, country_code, connection_type )` )

        // Speed up cleanup deletes that filter on updated_at
        await pool.query( `CREATE INDEX IF NOT EXISTS idx_workers_updated_at ON workers ( updated_at )` )

        // Global invariant: an ip can have many historical rows, but only one row may be `up`
        await pool.query( `
            CREATE UNIQUE INDEX IF NOT EXISTS idx_workers_single_up_ip
            ON workers (ip)
            WHERE status = 'up'
        ` ).catch( async e => {

            log.warn( `Could not create one-up-per-ip index on workers: ${ e.message }` )
            log.info( `Attempting to remove duplicate active ips and retry...` )

            try {

                // Keep the most recent `up` row per ip and drop older competing `up` rows
                await pool.query( `
                    DELETE FROM workers w
                    USING (
                        SELECT ctid
                        FROM (
                            SELECT
                                ctid,
                                ROW_NUMBER() OVER (
                                    PARTITION BY ip
                                    ORDER BY updated_at DESC, mining_pool_uid DESC, mining_pool_url DESC
                                ) AS row_num
                            FROM workers
                            WHERE status = 'up'
                        ) ranked
                        WHERE row_num > 1
                    ) duplicates
                    WHERE w.ctid = duplicates.ctid
                ` )

                // Retry index creation after cleanup
                await pool.query( `
                    CREATE UNIQUE INDEX IF NOT EXISTS idx_workers_single_up_ip
                    ON workers (ip)
                    WHERE status = 'up'
                ` )
                log.info( `✅ Created one-up-per-ip workers index after deduping active rows` )
            } catch ( cleanup_error ) {
                log.error( `Failed to enforce one-up-per-ip index on workers: ${ cleanup_error.message }` )
            }
        } )
    }

    // Create the WORKER_PERFORMANCE table if it doesn't exist
    if( miner_mode || validator_mode ) {
        await pool.query( `
            CREATE TABLE IF NOT EXISTS worker_performance (
                ip TEXT NOT NULL,
                status TEXT NOT NULL,
                public_url TEXT NOT NULL,
                updated_at BIGINT NOT NULL
            )
        ` )
        log.info( `✅ Worker performance table initialized` )

        // Speed up time-range reads and cleanup deletes on the append-only performance log
        await pool.query( `CREATE INDEX IF NOT EXISTS idx_worker_performance_updated_at ON worker_performance ( updated_at )` )
    }

    // Create WORKER_BROADCAST_METADATA table if it does not exist yet
    if( miner_mode || validator_mode ) {
        await pool.query( `
            CREATE TABLE IF NOT EXISTS worker_broadcast_metadata (
                mining_pool_uid TEXT NOT NULL PRIMARY KEY,
                last_known_worker_pool_size BIGINT NOT NULL,
                updated BIGINT NOT NULL
            )
        ` )
        log.info( `✅ Worker broadcast metadata table initialized` )
    }

    // Create MINING_POOL_METADATA_BROADCAST table if it does not exist yet
    if( validator_mode ) {
        await pool.query( `
            CREATE TABLE IF NOT EXISTS mining_pool_metadata_broadcast (
                mining_pool_uid TEXT NOT NULL,
                mining_pool_ip TEXT NOT NULL,
                protocol TEXT NOT NULL,
                url TEXT NOT NULL,
                port INTEGER NOT NULL,
                updated BIGINT NOT NULL,
                PRIMARY KEY (mining_pool_uid, mining_pool_ip)
            )
        ` )
        log.info( `✅ Mining pool metadata broadcast table initialized` )
    }

    // Create challenge/solution table if it does not exist yet
    if( miner_mode || validator_mode ) {
        await pool.query( `
            CREATE TABLE IF NOT EXISTS challenge_solution (
                challenge TEXT NOT NULL,
                solution TEXT NOT NULL,
                PRIMARY KEY (challenge),
                updated BIGINT NOT NULL
            )
        ` )
        log.info( `✅ Challenge solution table initialized` )
    }

    // Create SCORES table if it doesn't exist yet
    if( validator_mode ) {
        await pool.query( `
            CREATE TABLE IF NOT EXISTS scores (
                PRIMARY KEY (mining_pool_uid, mining_pool_ip),
                mining_pool_ip TEXT NOT NULL,
                mining_pool_uid TEXT NOT NULL,
                stability_score NUMERIC NOT NULL,
                size_score NUMERIC NOT NULL,
                performance_score NUMERIC NOT NULL,
                geo_score NUMERIC NOT NULL,
                score NUMERIC NOT NULL,
                updated BIGINT NOT NULL
            )
        ` )
        log.info( `✅ Scores table initialized` )
    }

    // Create the WORKER_WIREGUARD_CONFIGS table if it doesn't exist
    if( worker_mode ) {
        await pool.query( `
            CREATE TABLE IF NOT EXISTS worker_wireguard_configs (
                id SERIAL PRIMARY KEY,
                expires_at BIGINT NOT NULL,
                updated_at TIMESTAMP NOT NULL
            )
        ` )
        log.info( `✅ Worker WireGuard configs table initialized` )

        // Speed up expired lease lookups and cleanup deletes
        await pool.query( `CREATE INDEX IF NOT EXISTS idx_wg_configs_expires_at ON worker_wireguard_configs ( expires_at )` )

    }

    // Create the WORKER_SOCKS5_CONFIGS table if it doesn't exist
    if( worker_mode ) {
        await pool.query( `
            CREATE TABLE IF NOT EXISTS worker_socks5_configs (
                id SERIAL PRIMARY KEY,
                ip_address TEXT NOT NULL,
                port INTEGER NOT NULL,
                username TEXT NOT NULL UNIQUE,
                password TEXT NOT NULL,
                available BOOLEAN NOT NULL DEFAULT TRUE,
                expires_at BIGINT NOT NULL,
                updated BIGINT NOT NULL
            )
        ` )
        log.info( `✅ Worker Socks5 configs table initialized` )

        // Speed up lease allocation queries that filter on availability
        await pool.query( `CREATE INDEX IF NOT EXISTS idx_socks5_available ON worker_socks5_configs ( available, id )` )

        // Speed up expired lease lookups and cleanup deletes
        await pool.query( `CREATE INDEX IF NOT EXISTS idx_socks5_expires_at ON worker_socks5_configs ( expires_at )` )
    }

    // Create the IP_GEODATA_CACHE table for caching MaxMind / geoip results
    if( miner_mode || validator_mode ) {
        await pool.query( `
            CREATE TABLE IF NOT EXISTS ip_geodata_cache (
                ip TEXT PRIMARY KEY,
                country_code TEXT,
                datacenter BOOLEAN NOT NULL DEFAULT FALSE,
                connection_type TEXT NOT NULL DEFAULT 'unknown',
                user_type TEXT,
                connection_type_raw TEXT,
                user_count INTEGER,
                source TEXT,
                updated_at BIGINT NOT NULL,
                expires_at BIGINT NOT NULL
            )
        ` )
        log.info( `✅ IP geodata cache table initialized` )

        // Speed up expired entry lookups and cleanup
        await pool.query( `CREATE INDEX IF NOT EXISTS idx_ip_geodata_cache_expires_at ON ip_geodata_cache ( expires_at )` )
    }

    // Create the TIMESTAMPS table if it doesn't exist
    await pool.query( `
        CREATE TABLE IF NOT EXISTS timestamps (
            label TEXT PRIMARY KEY,
            timestamp BIGINT NOT NULL,
            updated BIGINT NOT NULL,
            UNIQUE (label)
        )
    ` )
    log.info( `✅ Timestamps table initialized` )

    /* ///////////////////////////////
    // Backwards compatibility section
    // ///////////////////////////// */

    // If mining_pool_metadata_broadcast has no updated column, add it (check if table exists first)
    if( validator_mode ) {
        await pool.query( `
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'mining_pool_metadata_broadcast') THEN
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='mining_pool_metadata_broadcast' AND column_name='updated') THEN
                        ALTER TABLE mining_pool_metadata_broadcast ADD COLUMN updated BIGINT NOT NULL DEFAULT 0;
                        RAISE NOTICE 'Added updated column to mining_pool_metadata_broadcast table';
                    END IF;
                END IF;
            END
            $$;
        ` )
    }

    // If the challenge_solution table is missing updated column, add it (check if table exists first)
    if( miner_mode || validator_mode ) {
        await pool.query( `
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'challenge_solution') THEN
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='challenge_solution' AND column_name='updated') THEN
                        ALTER TABLE challenge_solution ADD COLUMN updated BIGINT NOT NULL DEFAULT 0;
                        RAISE NOTICE 'Added updated column to challenge_solution table';
                    END IF;
                END IF;
            END
            $$;
        ` )
    }

    // If scores has no update field, add it (check if table exists first)
    if( validator_mode ) {
        await pool.query( `
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'scores') THEN
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='scores' AND column_name='updated') THEN
                        ALTER TABLE scores ADD COLUMN updated BIGINT NOT NULL DEFAULT 0;
                        RAISE NOTICE 'Added updated column to scores table';
                    END IF;
                END IF;
            END
            $$;
        ` )
    }

    // If scores have integer fields, convert them to numeric (check if table exists first)
    if( validator_mode ) {
        await pool.query( `
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'scores') THEN
                    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='scores' AND column_name='stability_score' AND data_type='integer') THEN
                        ALTER TABLE scores ALTER COLUMN stability_score TYPE NUMERIC USING stability_score::NUMERIC;
                        RAISE NOTICE 'Converted stability_score to NUMERIC in scores table';
                    END IF;
                    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='scores' AND column_name='size_score' AND data_type='integer') THEN
                        ALTER TABLE scores ALTER COLUMN size_score TYPE NUMERIC USING size_score::NUMERIC;
                        RAISE NOTICE 'Converted size_score to NUMERIC in scores table';
                    END IF;
                    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='scores' AND column_name='performance_score' AND data_type='integer') THEN
                        ALTER TABLE scores ALTER COLUMN performance_score TYPE NUMERIC USING performance_score::NUMERIC;
                        RAISE NOTICE 'Converted performance_score to NUMERIC in scores table';
                    END IF;
                    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='scores' AND column_name='geo_score' AND data_type='integer') THEN
                        ALTER TABLE scores ALTER COLUMN geo_score TYPE NUMERIC USING geo_score::NUMERIC;
                        RAISE NOTICE 'Converted geo_score to NUMERIC in scores table';
                    END IF;
                    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='scores' AND column_name='score' AND data_type='integer') THEN
                        ALTER TABLE scores ALTER COLUMN score TYPE NUMERIC USING score::NUMERIC;
                        RAISE NOTICE 'Converted score to NUMERIC in scores table';
                    END IF;
                END IF;
            END
            $$;
        ` )
    }

    // If worker table is missing type column, add it (check if table exists first)
    if( miner_mode || validator_mode ) {
        await pool.query( `
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'workers') THEN
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='workers' AND column_name='connection_type') THEN
                        ALTER TABLE workers ADD COLUMN connection_type TEXT NOT NULL DEFAULT 'unknown';
                        RAISE NOTICE 'Added connection_type column to workers table';
                    END IF;
                END IF;
            END
            $$;
        ` )
    }

    // Add unique constraint on worker_socks5_configs.username if it doesn't exist
    if( worker_mode ) {
        await pool.query( `
            CREATE UNIQUE INDEX IF NOT EXISTS worker_socks5_configs_username_unique ON worker_socks5_configs (username)
        ` ).catch( async e => {

            // If creation failed (likely due to duplicates), clean up and retry
            log.warn( `Could not create unique index on worker_socks5_configs.username: ${ e.message }` )
            log.info( `Attempting to remove duplicate usernames and retry...` )

            try {

                // Delete duplicates keeping the row with the highest id (latest insert)
                await pool.query( `
                    DELETE FROM worker_socks5_configs a
                    USING worker_socks5_configs b
                    WHERE a.username = b.username
                    AND a.id < b.id
                ` )

                // Retry creating the unique index
                await pool.query( `
                CREATE UNIQUE INDEX IF NOT EXISTS worker_socks5_configs_username_unique ON worker_socks5_configs (username)
            ` )
            } catch ( e ) {
                log.error( `Failed to remove duplicates and create unique index on worker_socks5_configs.username: ${ e.message }` )
            }

            log.info( `✅ Successfully created unique index after removing duplicates` )

        } )
    }

    // If ip_geodata_cache is missing the source column, add it to track where data came from
    if( miner_mode || validator_mode ) {
        await pool.query( `
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'ip_geodata_cache') THEN
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='ip_geodata_cache' AND column_name='source') THEN
                        ALTER TABLE ip_geodata_cache ADD COLUMN source TEXT;
                        RAISE NOTICE 'Added source column to ip_geodata_cache table';
                    END IF;
                END IF;
            END
            $$;
        ` )
    }

    // Rename country → country_code in ip_geodata_cache to match the JS field name
    if( miner_mode || validator_mode ) {
        await pool.query( `
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='ip_geodata_cache' AND column_name='country') THEN
                    ALTER TABLE ip_geodata_cache RENAME COLUMN country TO country_code;
                    RAISE NOTICE 'Renamed country column to country_code in ip_geodata_cache table';
                END IF;
            END
            $$;
        ` )
    }

    log.info( `✅ Backwards compatibility section complete` )

}
