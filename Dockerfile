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
    nodejs \
    npm \
    redis-server \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Install specific version of FFmpeg (4.4.4)
RUN add-apt-repository ppa:savoury1/ffmpeg4 && \
    apt-get update && \
    apt-get install -y ffmpeg=4.4.4-0ubuntu1~18.04.sav1.1 && \
    apt-mark hold ffmpeg && \
    rm -rf /var/lib/apt/lists/*

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

# Expose port for Redis (if you need to expose it)
EXPOSE 6379

# Setup Redis server for local development
RUN sed -i 's/bind 127.0.0.1/bind 0.0.0.0/g' /etc/redis/redis.conf

# Set default environment variables (will be overridden by .env file if it exists)
ENV REDIS_HOST=localhost \
    REDIS_PORT=6379 \
    MAX_PROCESS=4 \
    DEFAULT_BITRATE=500 \
    DEFAULT_MAX_DURATION=10

# Commands to run
CMD service redis-server start && \
    echo "FFmpeg version:" && \
    ffmpeg -version && \
    echo "Starting application with environment from .env file..." && \
    node -r dotenv/config index.js
