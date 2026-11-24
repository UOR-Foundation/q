# Changelog

This project follows Semantic Versioning and Conventional Commits.

## Unreleased

### Changed

- Renamed to Q: the repository is UOR-Foundation/q, the app and its holo are `q` (`q.holo`), and the kernel's signer is `UOR-Foundation/q`'s `holo.yml` on `main`. The client is regenerated as `Q`.

### Added

- Q replaces UOR Bot (carl-bot) for the rules reaction role. When a member confirms the #rules message with ✅, they get the member role, and removing the ✅ takes it away. This is decision 18, proved by `Policy.roleOnlyFromRules` and `Policy.confirmNeverRevokes` (DA-23). At start, anyone who confirmed while Q was away is given the role. Configure it with `RULES_MESSAGE`, `MEMBER_ROLE` and `RULES_EMOJI`.

- Q reads every conversation in a server: the backfill covers every active thread and every public archived thread, so every forum post is included. A channel Q may not read is skipped, and the rest of the server is still read.
- What is deleted or edited on Discord is withdrawn from Q's memory. A deleted message, thread or channel is forgotten. An edited message is re-indexed with its new text. When Q has a copy of the old text, it recomputes that chunk's BLAKE3 label and removes it directly; otherwise it finds the chunk by its link.

- LangBot's remaining pipeline stages as proved decisions: access control (DA-16), content filter both ways (DA-17), long-text delivery (DA-18), and MCP tool calls (DA-19); an adapter interface, a query pool, an Ollama provider, and an MCP client with a tool loop for each provider.
- The community root: the signed UOR-Foundation/community holo, pinned by its BLAKE3 label and verified SLSA provenance; its decisions answered in replies (DA-14); its channel labels; a read-policy drift check at every start (DA-13).
- A record of every turn: context and answer records named by BLAKE3 kappa labels, and a CloudEvents event with no content (DA-15), with JSON schemas in docs/schemas.
- A message addressed to the agent is never indexed (DA-02, `Policy.noRequestIndexed`).
- `.github/workflows/holo.yml`: the holo built, verified, provenance-signed and published to Pages.

### Added (LangBot's runtime graph, in full)

- A message aggregator: a burst from one person in one channel is one question (`AGGREGATE_MS`).
- A per-session controller: one question per person and channel at a time, beside the global pool.
- Conversation history: a reply to Q builds on the same author's recent turns, each admitted by the kernel (DA-21), named in the context record and in the answer key.
- Q's own MCP server on stdio (`node src/main.ts mcp`): `ask`, `search`, `status`, `community_apps`, `community_decide`, serving public items only (DA-22).
- `ARCHITECTURE.md` in LangBot's structure. prism-code 0.11.2.

### Added (speed and accuracy, from a stress run)

- Compute once: each answer carries its answer key, the BLAKE3 label of the normalized question, the kernel, the community pin, the evidence, the prompts and the model; the same key reuses the computed answer, the reply says so, and forgetting the author forgets the reuse.
- A decision's inputs are read while the plain answer is written, so a question that is not a decision waits for neither.
- A gate on model calls (`LLM_CONCURRENCY`) and retry with backoff on 429 and 503: a burst queues instead of failing. A failed answer is said, not left silent. Discord shows Q typing once the kernel decides to answer.
- An empty mention is answered at once; retrieval reads the first 1,000 characters of a question; a model that finds no answer in the sources gives a plain refusal.
- Per-stage timings in the reply log; the folder store reads its edge log incrementally; `bench/stress.ts` and its question set.

### Added (provenance)

- The host runs only a kernel whose exact bytes this repository's `holo.yml` signed from `main` (DA-20); its commit is in every context record. Provenance is one module for both holos.

### Changed

- prism-code 0.11.2 for the build and the host runtime.
- Superseded chunks are revoked after a complete ingest, so the index shows each source as it is now.

### Added (first version)

- The decision kernel: twelve conformance IDs, 17 theorems proved by Lean's kernel, 80 acceptance vectors.
- The host shell: Discord adapter, pipeline, kappa-label addressing, folder and Kappa Registry stores, search index.
- Knowledge sources: the community model, uor.foundation, the GitHub organization, and Discord messages.
- `/ask`, `/search`, `/status`, `/reindex`, `/forget-channel`, `/forget-me`, history backfill and a retention sweep.
- Anthropic and OpenAI-compatible language models; OpenAI-compatible embeddings.
