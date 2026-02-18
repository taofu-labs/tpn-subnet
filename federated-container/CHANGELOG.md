# Changelog

## [1.2.47] - 2026-02-18

### Changed
- enforce WireGuard egress IP to match claimed worker IP during scoring
- mark egress identity mismatches as `cheat` instead of generic `down`
- include `cheat` in worker status filtering and uptime aggregation

