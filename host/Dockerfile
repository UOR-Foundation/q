# The host shell. Build from the repository root, after the kernel is built and verified:
#   npx prism-code@0.11.2 build && npx prism-code@0.11.2 verify
# Use the version host/package.json pins: the runtime that reads the holo must match the build that wrote it.
#   docker build -f host/Dockerfile -t q .
# The image carries the holo it was built with; the host replays its vectors at every start.
FROM node:22-slim
WORKDIR /agent/host
COPY host/package.json host/package-lock.json ./
RUN npm ci --omit=dev
COPY host/src ./src
COPY host/web ./web
COPY app/.prism/build/q.holo /agent/kernel/q.holo
COPY experiments /agent/experiments
ENV KERNEL_HOLO=/agent/kernel/q.holo \
    STORE_DIR=/data/store \
    INDEX_FILE=/data/index.sqlite \
    BACKFILL_FILE=/data/backfill.json \
    COMMUNITY_CACHE_DIR=/data/community \
    KERNEL_PROVENANCE_FILE=/data/kernel.provenance.json
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
CMD ["node", "--no-warnings", "src/main.ts"]
