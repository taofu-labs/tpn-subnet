FROM python:3.10-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    git \
    build-essential \
    jq \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy requirements and install
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

# Copy source code
COPY . .

# Set PYTHONPATH to include the current directory
ENV PYTHONPATH="/app"

# Ensure entrypoint is executable
RUN chmod +x entrypoint.sh

# Bittensor keys are expected to be mounted at /root/.bittensor
# Config is expected to be mounted at /app/.env

ENTRYPOINT ["./entrypoint.sh"]
