# Use ubuntu server lts base
FROM ubuntu:24.04

# Install security updates
ENV DEBIAN_FRONTEND=noninteractive
RUN apt update \
    && apt install -y --no-install-recommends \
        dante-server \
        gettext-base \
        iproute2 \
        netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*

# Copy our dante config file
COPY dante/danted.conf.template /etc/danted.conf.template

# Copy startup script
COPY --chmod=755 dante/gen_users_and_start.sh /usr/local/bin/gen_users_and_start.sh

# Document the dante server port
EXPOSE 1080

# Start the dante server
CMD ["/usr/local/bin/gen_users_and_start.sh"]

# Healthcheck call, expect the dante server to be up and listening on port 1080
HEALTHCHECK --interval=10s --timeout=5s --start-period=600s --retries=3 CMD nc -z localhost 1080 || exit 1
