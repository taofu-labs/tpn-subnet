# Changelog

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
