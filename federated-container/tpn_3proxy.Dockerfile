# HTTP proxy layer — bridges HTTP CONNECT to Dante's SOCKS5
# 3proxy official image is busybox:glibc (no package manager),
# so we copy the binary into Alpine for bash/inotify/nc support.
FROM 3proxy/3proxy:latest AS upstream
FROM alpine:3.21

RUN apk add --no-cache bash inotify-tools netcat-openbsd

# Grab the 3proxy binary from the official image
COPY --from=upstream /bin/3proxy /usr/local/bin/3proxy

# Entrypoint script reads /passwords/*.password and generates 3proxy.cfg
COPY --chmod=755 3proxy/gen_config_and_start.sh /usr/local/bin/gen_config_and_start.sh

# Prepare writable dirs for the unprivileged user
RUN mkdir -p /etc/3proxy /var/run/3proxy && \
    chown 65535:65535 /etc/3proxy /var/run/3proxy

EXPOSE 3128

# Drop to the same unprivileged user the official image uses
USER 65535:65535

ENTRYPOINT ["/usr/local/bin/gen_config_and_start.sh"]

HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
    CMD nc -z localhost ${PROXY_PORT:-3128} || exit 1
