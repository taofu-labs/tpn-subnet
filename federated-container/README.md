# TPN Federated Network

Docker Compose setup for running TPN (The Privacy Network) federated nodes.

- Refer to the `README.md` in the root folder for instructions
- Refer to `TESTING.md` if you are a Taofu developer who wants to do internal testing
- Refer to `SPECIFICATION.md` for an architecture overview, but keep in mind this may be outdated
- Validator/score paths now enforce WireGuard and SOCKS5 egress identity against claimed worker IP (endpoint IP may differ for multi-hop routing)
- Worker broadcasts now include `HTTP_PROXY_PORT` metadata for the 3proxy HTTP proxy listener, matching the existing Dante `DANTE_PORT` SOCKS5 metadata path
- Internal worker scoring validates the 3proxy HTTP proxy bridge with the same credentials as Dante/SOCKS5; third-party mining pools are skipped for this check
