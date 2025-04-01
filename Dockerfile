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

# Install dependencies needed to build FFmpeg with SSL support
RUN apt-get update && apt-get install -y \
    build-essential \
    yasm \
    pkg-config \
    libx264-dev \
    libmp3lame-dev \
    libopus-dev \
    libvpx-dev \
    libfdk-aac-dev \
    nasm \
    libssl-dev \
    openssl \
    libgnutls28-dev

# Download and install FFmpeg 4.4.4 from source with SSL support
RUN cd /tmp && \
    wget https://ffmpeg.org/releases/ffmpeg-4.4.4.tar.bz2 && \
    tar -xjf ffmpeg-4.4.4.tar.bz2 && \
    cd ffmpeg-4.4.4 && \
    ./configure \
      --enable-gpl \
      --enable-nonfree \
      --enable-libfdk-aac \
      --enable-libmp3lame \
      --enable-libopus \
      --enable-libvpx \
      --enable-libx264 \
      --enable-openssl \
      --enable-protocol=https \
      --enable-protocol=http \
      && \
    make -j$(nproc) && \
    make install && \
    ldconfig && \
    ffmpeg -version && \
    cd /tmp && \
    rm -rf ffmpeg-4.4.4 ffmpeg-4.4.4.tar.bz2 && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Create necessary directories with proper permissions
RUN mkdir -p /tmp/temp && chmod 777 /tmp/temp

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
    NODE_ENV=production \
    TEMP=/tmp/temp \
    DEFAULT_BITRATE=500 \
    DEFAULT_MAX_DURATION=10 \
    REMBG_URL=http://rembg:7000

# Install tini init system from official releases
RUN wget -O /usr/local/bin/tini https://github.com/krallin/tini/releases/download/v0.19.0/tini && \
    chmod +x /usr/local/bin/tini

# Use tini as entrypoint for proper signal handling in containerized environments
ENTRYPOINT ["/usr/local/bin/tini", "--"]

# Commands to run with JSON format
CMD ["node", "-r", "dotenv/config", "index.js"]
