# Use linuxserver wireguard image base
FROM lscr.io/linuxserver/wireguard:latest

# Overwrite the /etc/s6-overlay/s6-rc.d/init-wireguard-confs/run file with our local ./tpn_wireguard.init.sh file
COPY tpn_wireguard.init.sh /etc/s6-overlay/s6-rc.d/init-wireguard-confs/run
RUN chmod +x /etc/s6-overlay/s6-rc.d/init-wireguard-confs/run

# Add a healthcheck that checks if wireguard server is up and reachable on the configured details from docker-compose.yml
HEALTHCHECK --interval=5s --timeout=5s --start-period=120s --retries=5 CMD wg show wg0 > /dev/null 2>&1 && nc -vzu $SERVERURL $SERVERPORT | grep -q succeeded || exit 1
