# Changelog

## [1.5.0] - 2026-04-07

### Added
- validator-to-validator geodata fallback when MaxMind fails
- `GET /validator/broadcast/geodata/:ip` endpoint for peer cache lookups
- validator 0 prioritised as first fallback peer

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
