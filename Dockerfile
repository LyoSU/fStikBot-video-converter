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

# Set default environment variables (will be overridden by .env file if it exists)
ENV REDIS_HOST=redis \
    REDIS_PORT=6379 \
    MAX_PROCESS=4 \
    DEFAULT_BITRATE=500 \
    DEFAULT_MAX_DURATION=10

# Commands to run
CMD echo "FFmpeg version:" && \
    ffmpeg -version && \
    echo "Starting application with environment from .env file..." && \
    echo "Connecting to Redis at: ${REDIS_HOST}:${REDIS_PORT}" && \
    node -r dotenv/config index.js
