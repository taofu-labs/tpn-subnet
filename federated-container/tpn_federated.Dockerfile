# Use Nodejs image base
FROM node:24-slim

# Set the working directory inside the container
WORKDIR /app

# Memory default
ENV MAX_PROCESS_RAM_MB=8192

# Cachebuster, used in local development to force rebuilds
ARG CACHEBUST=1
RUN echo "CACHEBUST=$CACHEBUST"

# Install all dependencies
ENV DEBIAN_FRONTEND=noninteractive
RUN apt update && apt install -y --no-install-recommends \
    # curl for healthcheck
    curl \
    # certificates
    ca-certificates \
    # wireguard for vpn connections
    wireguard wireguard-tools \
    # networking tools
    iproute2 dnsutils iputils-ping iptables \
    # wg-quick dependencies
    procps \
    # git
    git \
    # ncat
    netcat-openbsd \
    # gpg for docker repo
    gnupg \
    # cleanup cache for image size reduction
    && apt clean && rm -rf /var/lib/apt/lists/*

# Install Docker CLI from official Docker repository
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources-list.d/docker.list \
    && apt update && apt install -y --no-install-recommends docker-ce-cli \
    && apt clean && rm -rf /var/lib/apt/lists/*

# wg-quick resolver dependency
RUN apt update && apt install -y --no-install-recommends resolvconf || echo "resolvconf postinstall is expected to fail"; apt clean && rm -rf /var/lib/apt/lists/*
RUN echo '#!/bin/sh\nexit 0' > /var/lib/dpkg/info/resolvconf.postinst && chmod +x /var/lib/dpkg/info/resolvconf.postinst
RUN dpkg --configure resolvconf

# Configure git
RUN git config --global --add safe.directory /app

# Copy package management files
COPY package*.json ./

# Install dependencies, data files from maxmind and ip2location are downloaded later and not during build
RUN npm config set update-notifier false
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

# Copy application code
COPY app.js ./
COPY modules ./modules
COPY routes ./routes

# Expose the port the app runs on
EXPOSE 3000

# Serve the app
CMD ["node", "--trace-gc", "app.js"]

# Healthcheck call, expect 200. Note that due to maxmind boot updates we need a long start period
HEALTHCHECK --interval=10s --timeout=10s --start-period=600s --retries=3 CMD curl -f http://localhost:3000/ || exit 1
