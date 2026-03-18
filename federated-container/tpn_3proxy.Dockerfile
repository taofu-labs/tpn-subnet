# HTTP proxy layer — bridges HTTP CONNECT to Dante's SOCKS5
FROM 3proxy/3proxy:latest

# Official 3proxy image is Alpine-based (uid/gid 65535)
USER root
RUN apk add --no-cache bash inotify-tools

# Entrypoint script reads /passwords/*.password and generates 3proxy.cfg
COPY --chmod=755 3proxy/gen_config_and_start.sh /usr/local/bin/gen_config_and_start.sh

EXPOSE 3128

ENTRYPOINT ["/usr/local/bin/gen_config_and_start.sh"]

HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
    CMD nc -z localhost ${PROXY_PORT:-3128} || exit 1
