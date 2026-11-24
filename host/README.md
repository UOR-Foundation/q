# Host shell

Everything the agent does that has an effect. It holds no policy: before each effect it asks the kernel and obeys.

```
Discord event
  -> adapter/discord.ts   facts about the channel, author and trigger
  -> memory.ts            index this message?                                  (kernel)
  -> pipeline.ts          reply? access? filter in? command? rate?             (kernel, each one)
  -> search.ts            keyword and vector search, keyed by label
  -> pipeline.ts          cite? grounded? community decision? level? order?    (kernel and the community holo)
  -> providers.ts         language model, with MCP tools: call?                (kernel, every call)
  -> pipeline.ts          filter out? long text: send, split or file?          (kernel)
  -> records.ts           context record, answer record, event                 (docs/context.md)
  -> adapter/discord.ts   reply with citations, claim level and decision
```

| File | Does |
| --- | --- |
| `src/kernel.ts` | Opens the holo, replays its vectors, encodes each question as eight bytes |
| `src/client/` | Bindings written by `prism-code generate`. Do not edit |
| `src/address.ts` | The `blake3:` kappa label of a JSON item, by `@uor-foundation/uor-addr` |
| `src/store.ts` | Store of record: memory (tests), folder, Kappa Registry |
| `src/search.ts` | The derived index, in Node's built-in SQLite |
| `src/knowledge.ts` | Sources (community model, uor.foundation, GitHub organization), chunking, ingestion |
| `src/memory.ts` | Discord messages: indexing, forgetting, retention |
| `src/pipeline.ts` | The stages from message to reply, the query pool, and the commands |
| `src/community.ts` | The community root: its signed holo, the pinned commit, its decision catalog and channel labels, the read-policy drift check |
| `src/records.ts` | The context record, the answer record and the event of every turn; the website's manifest, question key and public answer record |
| `src/aggregator.ts` | LangBot's message aggregator: a burst from one person in one channel is one question |
| `src/provenance.ts` | Sigstore verification of a holo's signed SLSA provenance, for both holos |
| `src/mcp-server.ts` | Q's own MCP server, on stdio (`node src/main.ts mcp`) and over HTTP at `/mcp` of the website's adapter: public items only |
| `src/tools.ts` | MCP client: lists every configured server's tools and runs a call the kernel allowed |
| `src/providers.ts` | Language models (Anthropic, OpenAI-compatible, Ollama), each with a tool loop, and embeddings |
| `src/adapter/adapter.ts` | The platform adapter interface, and how a reply is cut into messages |
| `src/adapter/discord.ts` | discord.js: mentions, replies, slash commands, files, history backfill |
| `src/adapter/web.ts` | The website's adapter: the manifest, an answer by its question key, a source by its label, and a question answered as server-sent events. For other agents: how to ask at `/`, a question answered whole by one GET, and the MCP server at `/mcp`. Public items only. See `../docs/web.md` |

## Run

Node 22.18 or later. No build step: Node runs the TypeScript directly.

```bash
npm ci
npm run typecheck
npm test
cp .env.example .env    # then fill it in
npm run ingest          # community model, uor.foundation, GitHub organization
npm run backfill        # history of every text channel the bot can see, each message decided by the kernel; resumable
npm start
```

`npm run generate` rewrites `src/client/` after the kernel is rebuilt.

`bench/stress.ts` runs the real pipeline, model, embeddings, index and community holo over `bench/questions.json` (grounded, decision, unanswerable, off-topic, injection, invented, empty and very long questions, each with the outcome a correct answer has), one at a time and then as a burst, and prints each answer, its stage timings and a summary. Run it against a copy of the data: each turn writes its records.

At start the host checks that the kernel's exact bytes are a build `UOR-Foundation/q`'s `holo.yml` signed from `main`, and refuses to run otherwise. A build of a published commit passes, because the build is reproducible. A model you changed and have not published does not: set `KERNEL_PROVENANCE=off` for that, on your own machine only.

## Deploy

On one machine with Docker, from the repository root:

```bash
npx prism-code@0.11.2 build && npx prism-code@0.11.2 verify
cp host/.env.example host/.env    # then fill it in
docker compose -f host/docker-compose.yml up -d --build
docker compose -f host/docker-compose.yml run --rm agent node --no-warnings src/main.ts ingest
```

Before the bot can index anything on a server:

1. In the Discord developer portal, enable the Message Content intent, and set `MESSAGE_CONTENT_INTENT=true`.
2. Have a server admin install the bot, and set `INSTALLED_BY_ADMIN=true`.
3. Channel labels come from `governance/discord.json` in `UOR-Foundation/community`: every channel @everyone can see is public unless that file labels it otherwise. To exclude a channel, change that file by pull request.

The bot answers mentions in any public text or forum channel. Its inputs and outputs are specified in [../docs/context.md](../docs/context.md).

## Commands

| Command | Who | Does |
| --- | --- | --- |
| `/ask` | everyone | Answer with citations and a claim level, or say it does not know |
| `/search` | everyone | List the best-matching sources without calling the language model |
| `/status` | everyone | Kernel model, chunks indexed, decision counts |
| `/reindex` | admin | Ingest the sources again; unchanged chunks are skipped |
| `/forget-channel` | admin | Delete everything indexed from the channel |
| `/forget-me` | everyone | Delete your messages and the answers to your questions, and stop indexing you |

## What is tested, and what is not

Tested (80 tests, real kernel, in-process store, embedder and language model): the website (the third surface in the kernel, an answer from public sources only whose public record holds no question, author or record label, a repeat read back by its question key with no retrieval, model or new record, a new manifest when the served index changes and none when a Discord message arrives, an answer forgotten when a source is altered or revoked, words shown as written but never a refusal word, a discarded answer or a text the filter could change, the adapter over HTTP with its origin check, size limit and rate limit, and a streamed completion without its reasoning), labels, chunking, deduplication, index rebuild, a cited answer listing only the sources it cites, source order, refusal of an ungrounded question, a tampered item, a revoked item, silence in DMs and restricted channels, command authorization, rate limiting, message indexing, a request to the agent never indexed, the read-policy drift check with one planted difference, channel labels, both turn records and the event against their published schemas for every kind of turn, a community decision answered and one with a missing input, superseded chunks after a newer commit, the kernel's and the community's provenance against real Sigstore bundles (verified, and refused for other bytes, another repository and another signer), the message aggregator, one question per session at a time, conversation history from the same author only and gone once forgotten, the MCP server over the protocol withholding every Discord item, access control under a whitelist and a blacklist, the content filter both ways and out of scope, long-text delivery, the query pool, MCP tools over the protocol with a read allowed, a write refused for a member and allowed for an admin, and a server not allowlisted, a Discord citation marked open, forget-me, forget-channel, the retention sweep.

Run once by hand on 2026-11-23: the community source (39 documents) and the website source (45 pages), 612 chunks together; the GitHub source on one repository (9 files, 34 issues and pull requests).

Run live on 2026-11-24, with `docker-compose.yml` on one VPS, against the test server "UOR Agent Test": the Discord adapter (mentions, replies, slash commands), an OpenAI-compatible language model (Qwen3.8-27B on Featherless), llama.cpp embeddings (nomic-embed-text-v1.5) and the folder store. Observed in `#general`:

- Grounded questions answered with inline citations, a claim level and kappa labels.
- An unanswerable question ("What will the price of Bitcoin be in December 2027?") refused twice in a row. Before the fix of 2026-11-24 the second asking was answered, because the first had been indexed and matched it; a message to the agent is now never indexed (DA-02, `Policy.noRequestIndexed`).
- `/forget-channel` forgot the channel's 7 indexed items.

The answer style the system prompt asks for (direct answer and why, then how, then something to use; terms defined; under 1,200 characters) is model behaviour, observed on a few answers, not guaranteed.

Not run:

- **Backfill.** `npm run backfill` has not been run against a server.
- **Anthropic and Ollama providers.** Only the OpenAI-compatible provider has run, against Featherless. No provider's tool loop has run against a real model.
- **A real MCP server.** MCP tools are tested over the protocol against an in-process server; no UOR MCP server is configured on the live agent.
- **The Kappa Registry.** `KappaRegistryStore` is written from the registry's README and has never met a live registry. Its blob digests are `sha256:`, so the kappa label is bound to each blob by a tag; whether the tag, edge and delete routes behave as assumed is unverified.
- **A clean-VPS deploy from this README alone.** The live run used a copy prepared by hand; the Milestone 3 gate is still open.
- **The whole GitHub organization.** It needs `GITHUB_TOKEN`; without one GitHub allows 60 requests an hour.

## Where the host still decides

Three things are not kernel decisions, and should be read as such:

- **Score band.** The host turns the best cosine similarity into low, medium or high using `SIMILARITY_MEDIUM` and `SIMILARITY_HIGH`. The kernel decides on the band; the thresholds are operator settings, uncalibrated.
- **Claim level of a source.** Each source declares its level: `some-true` for the community model, the website and repository files; `open` for issues and Discord messages. The kernel combines levels; it does not assign them.
- **Channel facts.** Whether a channel is public or excluded comes from the community's `governance/discord.json` at the pinned commit. The kernel trusts what it is told.
- **Decision inputs.** The language model reads a community decision's inputs from the question. That is interpretation; the answer says so, and the context record keeps it.

See [../docs/design.md](../docs/design.md) for the trade-offs.
