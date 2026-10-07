FROM mcr.microsoft.com/devcontainers/typescript-node:5-24-trixie

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libasound2t64 \
        libatk1.0-0t64 \
        libatspi2.0-0t64 \
        libdbus-1-3 \
        libgbm1 \
        libxcomposite1 \
        libxdamage1 \
        libxfixes3 \
        libxkbcommon0 \
        libxrandr2 \
        fonts-liberation \
        fonts-noto-color-emoji \
        fonts-unifont \
        libatk-bridge2.0-0 \
        libcups2 \
    && rm -rf /var/lib/apt/lists/*

USER node