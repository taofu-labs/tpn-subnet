# TPN Federated Network

Docker Compose setup for running TPN (The Privacy Network) federated nodes.

- Refer to the `README.md` in the root folder for instructions
- Refer to `TESTING.md` if you are a Taofu developer who wants to do internal testing
- Refer to `SPECIFICATION.md` for an architecture overview, but keep in mind this may be outdated
- Validator/score paths now enforce WireGuard egress identity against claimed worker IP (endpoint IP may differ for multi-hop routing)
