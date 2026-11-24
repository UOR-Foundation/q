# The host shell. Build from the repository root, after the kernel is built and verified:
#   npx prism-code@0.11.1 build && npx prism-code@0.11.1 verify
# Use the version host/package.json pins: the runtime that reads the holo must match the build that wrote it.
#   docker build -f host/Dockerfile -t uor-discord-agent .
# The image carries the holo it was built with; the host replays its vectors at every start.
FROM node:22-slim
WORKDIR /agent/host
COPY host/package.json host/package-lock.json ./
RUN npm ci --omit=dev
COPY host/src ./src
COPY app/.prism/build/uor-discord-agent.holo /agent/kernel/uor-discord-agent.holo
ENV KERNEL_HOLO=/agent/kernel/uor-discord-agent.holo \
    STORE_DIR=/data/store \
    INDEX_FILE=/data/index.sqlite \
    BACKFILL_FILE=/data/backfill.json \
    COMMUNITY_CACHE_DIR=/data/community
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
CMD ["node", "--no-warnings", "src/main.ts"]
