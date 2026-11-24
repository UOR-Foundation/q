# Changelog

This project follows Semantic Versioning and Conventional Commits.

## Unreleased

### Added

- LangBot's remaining pipeline stages as proved decisions: access control (DA-16), content filter both ways (DA-17), long-text delivery (DA-18), and MCP tool calls (DA-19); an adapter interface, a query pool, an Ollama provider, and an MCP client with a tool loop for each provider.
- The community root: the signed UOR-Foundation/community holo, pinned by its BLAKE3 label and verified SLSA provenance; its decisions answered in replies (DA-14); its channel labels; a read-policy drift check at every start (DA-13).
- A record of every turn: context and answer records named by BLAKE3 kappa labels, and a CloudEvents event with no content (DA-15), with JSON schemas in docs/schemas.
- A message addressed to the agent is never indexed (DA-02, `Policy.noRequestIndexed`).
- `.github/workflows/holo.yml`: the holo built, verified, provenance-signed and published to Pages.

### Added (speed and accuracy, from a stress run)

- Compute once: each answer carries its answer key, the BLAKE3 label of the normalized question, the kernel, the community pin, the evidence, the prompts and the model; the same key reuses the computed answer, the reply says so, and forgetting the author forgets the reuse.
- A decision's inputs are read while the plain answer is written, so a question that is not a decision waits for neither.
- A gate on model calls (`LLM_CONCURRENCY`) and retry with backoff on 429 and 503: a burst queues instead of failing. A failed answer is said, not left silent. Discord shows Q typing once the kernel decides to answer.
- An empty mention is answered at once; retrieval reads the first 1,000 characters of a question; a model that finds no answer in the sources gives a plain refusal.
- Per-stage timings in the reply log; the folder store reads its edge log incrementally; `bench/stress.ts` and its question set.

### Added (provenance)

- The host runs only a kernel whose exact bytes this repository's `holo.yml` signed from `main` (DA-20); its commit is in every context record. Provenance is one module for both holos.

### Changed

- prism-code 0.11.1 for the build and the host runtime.
- Superseded chunks are revoked after a complete ingest, so the index shows each source as it is now.

### Added (first version)

- The decision kernel: twelve conformance IDs, 17 theorems proved by Lean's kernel, 80 acceptance vectors.
- The host shell: Discord adapter, pipeline, kappa-label addressing, folder and Kappa Registry stores, search index.
- Knowledge sources: the community model, uor.foundation, the GitHub organization, and Discord messages.
- `/ask`, `/search`, `/status`, `/reindex`, `/forget-channel`, `/forget-me`, history backfill and a retention sweep.
- Anthropic and OpenAI-compatible language models; OpenAI-compatible embeddings.
