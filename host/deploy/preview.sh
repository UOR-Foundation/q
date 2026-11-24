#!/bin/sh
# Q's website on one machine, for a preview: the host in web mode against local embeddings and its own
# data folder, with the kernel as built here. Nothing here is a deployment, and no port leaves the machine.
#
#   host/deploy/get-model.sh                 # once: the embeddings model, checksum-verified
#   docker run -d --name q-preview-embed -p 127.0.0.1:8089:8080 -v "$PWD/host/models:/models:ro" \
#     ghcr.io/ggml-org/llama.cpp@sha256:6fab63852916c294cc8a2f1515079c4ca40248193eea8868ae742134335b989b \
#     --model /models/nomic-embed-text-v1.5.Q8_0.gguf --embeddings --pooling mean --ctx-size 2048 \
#     --batch-size 2048 --ubatch-size 2048 --host 0.0.0.0 --port 8080
#   host/deploy/preview.sh ingest            # once: index the public sources
#   host/deploy/preview.sh web               # serve http://127.0.0.1:8787 for a site on http://localhost:8080
#
# The language model's key is read from ENV_FILE (default host/.env) by Node and is never printed.
# A kernel built here is not signed, so its provenance check is off: for a preview only.
set -eu
cd "$(dirname "$0")/.."
export KERNEL_PROVENANCE=off
export EMBEDDINGS_URL="${EMBEDDINGS_URL:-http://127.0.0.1:8089/v1}"
export EMBEDDINGS_MODEL=nomic-embed-text-v1.5
export EMBEDDINGS_API_KEY=
export EMBEDDINGS_QUERY_PREFIX="search_query: "
export EMBEDDINGS_DOCUMENT_PREFIX="search_document: "
# Measured for this embeddings model; see docker-compose.yml.
export SIMILARITY_MEDIUM=0.60
export SIMILARITY_HIGH=0.70
export STORE_DIR=./data/store INDEX_FILE=./data/index.sqlite BACKFILL_FILE=./data/backfill.json
export COMMUNITY_CACHE_DIR=./data/community KERNEL_PROVENANCE_FILE=./data/kernel.provenance.json
export KAPPA_REGISTRY_URL=
export WEB_PORT="${WEB_PORT:-8787}" WEB_HOST=127.0.0.1
export WEB_ORIGINS="${WEB_ORIGINS:-http://localhost:8080,http://127.0.0.1:8080}"
exec node --no-warnings --env-file-if-exists="${ENV_FILE:-.env}" src/main.ts "${1:-web}"
