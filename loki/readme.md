# TPN Alloy Agent

Ships node metrics + Docker container logs + PM2 neuron logs from a fleet node
to the central tpn-obs receiver.

This is the **client** side. For the server stack see [`../server/`](../server/).

## How identity works

The partner never sets a hostname. tpn-cc is the source of truth:

1. On tpn-cc: `manage-tokens.sh add <node-name>` → issues a token bound to that name
2. The partner gets **two values**: `TELEMETRY_URL` + `TELEMETRY_KEY`
3. Alloy starts, calls `GET /identity` with the bearer token
4. The receiver returns the bound node name as plain text
5. Alloy uses that as the `host` label on all metrics and logs

No way for a partner to misconfigure their hostname — it's server-controlled.

## What it collects

| Source | Mechanism | Destination |
|---|---|---|
| Node metrics (CPU/RAM/disk/net) | `prometheus.exporter.unix`, 60s scrape | Mimir |
| Docker container logs | `discovery.docker` + `loki.source.docker` | Loki |
| PM2 neuron logs | `local.file_match` tailing `/home/pool/.pm2/logs/*.log` | Loki |

All traffic egresses to `TELEMETRY_URL:443` only. Bearer-token auth.

## Files

```
agent/
├── docker-compose.yml   # Alloy sidecar (network_mode: host, pid: host)
├── config.alloy         # Fleet-wide collector (no per-node edits ever)
└── .env.example         # TELEMETRY_URL + TELEMETRY_KEY (the only two things)
```

## Install on a new node

Prereqs: Docker + docker compose plugin, outbound 443 to the receiver.

1. **Register the node on tpn-cc**:
   ```bash
   cd /opt/tpn-obs/repo
   ./server/scripts/manage-tokens.sh add <node-name>
   ```
   This prints the two values. Copy them.

2. **Drop the agent files on the node**:
   ```bash
   sudo mkdir -p /opt/tpn-alloy
   # copy agent/docker-compose.yml + agent/config.alloy here
   ```

3. **Create .env** (paste the two values from step 1):
   ```bash
   cat > /opt/tpn-alloy/.env << 'EOF'
   TELEMETRY_URL=https://obs.taoprivatenetwork.com
   TELEMETRY_KEY=<token from step 1>
   EOF
   ```

4. **Start**:
   ```bash
   cd /opt/tpn-alloy
   sudo docker compose up -d
   ```

5. **Verify** in Grafana → *TPN Fleet Overview* → `$host` dropdown should list
   the new node within ~60s.

## Updating

Edit `config.alloy` here, commit, then on each node:
```bash
cd /opt/tpn-alloy
# copy updated config.alloy here
sudo docker compose restart
```

## Troubleshooting

- **No data in Grafana**: `docker logs tpn-alloy` — look for 401 (bad token) or
  DNS/connectivity errors to the receiver.
- **PM2 logs missing**: confirm `/home/pool/.pm2/logs/` exists on the host.
  Path is hardcoded in `config.alloy` — adjust if your PM2 user differs.
