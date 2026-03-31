# Changelog

## [1.3.0] - 2026-03-31

### Added
- expose lease extension token as `X-Lease-Extension-Token` response header on `/lease/new`

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
