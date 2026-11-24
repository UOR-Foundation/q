#!/bin/sh
# Fetch the embeddings model into host/models, and refuse it unless its SHA-256
# is the one Hugging Face publishes for that file.
set -eu
cd "$(dirname "$0")/.."
FILE=nomic-embed-text-v1.5.Q8_0.gguf
SHA256=3e24342164b3d94991ba9692fdc0dd08e3fd7362e0aacc396a9a5c54a544c3b7
URL="https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/$FILE"
mkdir -p models
if [ -f "models/$FILE" ] && echo "$SHA256  models/$FILE" | sha256sum -c --status; then
  echo "models/$FILE already present and verified"; exit 0
fi
curl -fL --retry 3 -o "models/$FILE.part" "$URL"
echo "$SHA256  models/$FILE.part" | sha256sum -c -
mv "models/$FILE.part" "models/$FILE"
echo "models/$FILE verified"
