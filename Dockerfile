FROM ubuntu:18.04

# Set noninteractive installation
ENV DEBIAN_FRONTEND=noninteractive

# Update and install necessary packages
RUN apt-get update && apt-get install -y \
    curl \
    software-properties-common \
    apt-transport-https \
    ca-certificates \
    gnupg \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 16.x (compatible with Ubuntu 18.04)
RUN curl -fsSL https://deb.nodesource.com/setup_16.x | bash - \
    && apt-get install -y nodejs \
    && node --version \
    && npm --version

# Install specific version of FFmpeg 4.4.4
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    python3-software-properties \
    software-properties-common \
    && add-apt-repository -y ppa:jonathonf/ffmpeg \
    && apt-get update \
    && apt-get install -y ffmpeg \
    && apt-mark hold ffmpeg \
    && ffmpeg -version | grep "ffmpeg version" \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the PNG image files
COPY circle.png corner.png lite.png medium.png ./

# Copy the application code
COPY index.js ./

# Copy the .env file if it exists
COPY .env* ./

# Create default .env file if it doesn't exist
RUN touch .env

# Set default environment variables (will be overridden by .env file if it exists)
ENV REDIS_HOST=redis \
    REDIS_PORT=6379 \
    MAX_PROCESS=4 \
    DEFAULT_BITRATE=500 \
    DEFAULT_MAX_DURATION=10 \
    NODE_ENV=production

# Set proper tini as entrypoint for better signal handling and zombie process reaping
RUN apt-get update && apt-get install -y tini && rm -rf /var/lib/apt/lists/*

# Use tini as entrypoint for proper signal handling in containerized environments
ENTRYPOINT ["/usr/bin/tini", "--"]

# Commands to run with JSON format
CMD ["node", "-r", "dotenv/config", "index.js"]
