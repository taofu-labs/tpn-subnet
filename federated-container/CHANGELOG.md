# Changelog

## [1.12.1] - 2026-05-04

### Fixed
- improve HTTP proxy validation failure codes and probe timing

## [1.12.0] - 2026-05-04

### Added
- validate first-party worker HTTP proxy egress through 3proxy

## [1.11.0] - 2026-05-04

### Added
- track and broadcast worker `HTTP_PROXY_PORT` metadata

## [1.10.1] - 2026-05-04

### Fixed
- use monotonic timers to prevent negative scoring durations

## [1.10.0] - 2026-04-29

### Added
- `concurrency` parameter on `validate_and_annotate_workers` (default 200) — caps parallel worker tests below the 255-slot veth subnet pool so high worker counts no longer starve the network namespace allocator
- `max_worker_test_time_s` parameter on `validate_and_annotate_workers` (default 60) — observability marker that flags worker tests exceeding this duration as `down` with a timeout error. The runner always awaits natural completion of the underlying wireguard test so the veth subnet slot is released before the next worker is picked up — cancelling the inner test would orphan its slot and silently violate the concurrency cap

### Fixed
- wireguard cleanup now removes the MASQUERADE iptables rule using `${ uplink_interface }` instead of a hardcoded `eth0`, so hosts whose uplink is `ens5` / `enp0s*` / etc. no longer leak NAT rules
- veth subnet selector in `network.js:mk_subnet_prefix` now correctly produces `{1..255}` via `random_number_between( 255 )`. The previous `random_number_between( 1, 254 )` form relied on mentie's reversed `(max_num, min_num=1)` signature and accidentally yielded `{2..254}` — same intent, but a maintenance trap for readers expecting `(min, max)`
- concurrent worker validation now preserves input order in returned successes/failures/statuses, matching the previous `Promise.allSettled` behavior

### Changed
- removed the obsolete `>250 workers` warning in `validate_and_annotate_workers` — superseded by the concurrency cap
- validator audits are now globally exclusive, wait for active scoring validation to drain, and run worker validation at concurrency 100; scoring also drops to concurrency 100 while an audit is pending/active

## [1.9.0] - 2026-04-20

### Added
- mark workers not updated by last scoring cycle as `stale` before validator broadcast
- add `stale` to valid worker status values in `get_workers`

## [1.8.0] - 2026-04-15

### Added
- expose `X-Entry-Ip` and `X-Exit-Ip` response headers on lease requests
- annotate WireGuard text configs with trailing `# Entry ip:` / `# Exit ip:` comment lines

## [1.7.0] - 2026-04-15

### Added
- cache `city_id`, `city_name`, `proxy_type`, `latitude`, `longitude` from MaxMind Insights in `ip_geodata_cache`
- add matching columns to `ip_geodata_cache` schema (existing tables unaltered — new columns populate on fresh inserts)

## [1.6.1] - 2026-04-14

### Fixed
- add missing `source` column to `ip_geodata_cache` CREATE TABLE schema (existing validators needed restart for migration)

## [1.6.0] - 2026-04-14

### Added
- track original resolution source (maxmind/geoip_lite) in `ip_geodata_cache` DB table
- `authoritative_only` mode now checks source provenance in both memory and DB caches
- backwards-compat migration adds `source` column to existing `ip_geodata_cache` tables

### Changed
- `authoritative_only: true` rejects all non-MaxMind data including legacy DB entries without source

## [1.5.3] - 2026-04-13

### Fixed
- drop malformed worker entries before validator broadcast preprocessing
- skip mining pool URL resolution for empty worker URL values

## [1.5.2] - 2026-04-13

### Fixed
- keep authoritative geodata cache hits on long TTL when MaxMind is enabled
- track geodata cache source so validator fallback stays on short retry TTL

## [1.5.1] - 2026-04-13

### Fixed
- resolve peer geodata requests through advertised validator public endpoints
- sanitise worker IPs before geodata lookups use miner-supplied values

## [1.5.0] - 2026-04-07

### Added
- validator-to-validator geodata fallback when MaxMind fails
- `GET /validator/broadcast/geodata/:ip` endpoint for peer cache lookups
- race all validator peers concurrently for fastest geodata response

## [1.4.0] - 2026-04-01

### Added
- add MaxMind Insights web API support to `ip_geodata` with multi-layer caching (in-memory → postgres → API)
- add `ip_geodata_cache` table for persistent geodata caching with 30-day expiry
- store extra MaxMind traits (userType, connectionType, userCount) in cache table

### Fixed
- fix package-lock.json version mismatch (1.3.3 → 1.4.0)
- fix in-memory cache TTL on MaxMind fallback suppressing retries for 30 days (now 5 min)
- add `ip_geodata_cache` to periodic database cleanup to prevent unbounded table growth
- fix cleanup guard skipping tables with `max_stale_minutes: 0`

### Changed
- `ip_geodata` now checks postgres cache before falling back to geoip-lite
- graceful fallback to geoip-lite when MaxMind API is unavailable or errors

## [1.3.3] - 2026-04-01

### Fixed
- fix 3proxy Dockerfile build: multi-stage with Debian slim (upstream binary is glibc-linked, incompatible with Alpine/musl)

## [1.3.2] - 2026-04-01

### Fixed
- fix `NameError` in validator fatal error handler (`print_exception` → `format_exception`)
- add missing `lease_seconds` to audit config requests preventing audit failures
- return `lease_ref` and `lease_expires_at` from lease extension for re-extension support
- trim whitespace from password files in 3proxy config generation to prevent config corruption

## [1.3.1] - 2026-03-31

### Added
- expose lease extension token as `X-Lease-Extension-Token` response header on `/lease/new`
- document `X-Lease-Extension-Token` response header in OpenAPI spec

### Fixed
- fix traceback logging in validator recording `None` instead of the actual stack trace

## [1.2.52] - 2026-03-25

### Fixed
- raise Express JSON body parser limit from 100KB to 5MB to prevent silent rejection of large worker broadcasts
- set nginx `client_max_body_size` to 10MB in SWAG reverse proxy config

## [1.2.48] - 2026-02-18

### Changed
- unify WireGuard and SOCKS5 egress identity checks through shared evaluator
- enforce SOCKS5 claimed worker egress matching in scoring paths
- map SOCKS5 egress identity mismatches to `cheat` status in scoring
- default `EGRESS_IDENTITY_ENFORCEMENT` to `true` (opt-out; disable with `EGRESS_IDENTITY_ENFORCEMENT=false`)

## [1.2.47] - 2026-02-18

### Changed
- enforce WireGuard egress IP to match claimed worker IP during scoring
- mark egress identity mismatches as `cheat` instead of generic `down`
- include `cheat` in worker status filtering and uptime aggregation
