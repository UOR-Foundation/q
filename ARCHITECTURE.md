# Architecture

A map of Q's moving parts, in the shape of [LangBot's ARCHITECTURE.md](https://github.com/langbot-app/LangBot/blob/master/ARCHITECTURE.md). When you need to change behaviour, start here, then follow the file references. [docs/langbot.md](docs/langbot.md) maps each LangBot component to Q's; [docs/context.md](docs/context.md) defines Q's inputs and outputs.

## What Q is

Q is the UOR Foundation's AI agent on Discord, built like LangBot with one difference: every decision is a LexLean model proved by Lean's kernel, packaged as a Prism application (`npx prism-code@latest init`). One host process owns:

- a Discord adapter behind a platform adapter interface;
- a message aggregator, a query pool and a per-session controller;
- a pipeline of stages, each asking the kernel before it acts;
- providers (Anthropic, OpenAI-compatible, Ollama) with a tool loop, an MCP client, and retrieval over a BLAKE3-addressed store;
- the community root: UOR-Foundation/community's signed holo, its decisions, labels and knowledge, at one pinned commit;
- an MCP server on stdio exposing a curated, public-only subset of the same service layer.

## Repository boundary

- `app/`, `model/`, `features/`: the kernel. LexLean modules, the claim ledger, the scenarios. Built by `prism-code` into `app/.prism/build/q.holo`.
- `host/`: everything with an effect. TypeScript on Node 22, no build step. It holds no policy.
- `docs/`: the design note, the input and output spec with JSON schemas, the LangBot map, the verification record.
- `.github/workflows/`: `ci.yml` proves and tests every change; `holo.yml` builds, signs and publishes the holo.

## Startup path

`host/src/main.ts`, in order:

1. Load configuration from the environment (`config.ts`).
2. Open the kernel: verify the holo's identities, replay its 188 vectors, and verify that its exact bytes are a build this repository's `holo.yml` signed (`provenance.ts`).
3. Open the store and the search index.
4. Open the community root: fetch its holo, verify its signed provenance, pin the newest commit, replay its vectors, admit each decision app whose examples it answers, read its channel labels, and check Q's read policy against it on all 96 requests (`community.ts`).
5. Connect the configured MCP servers (`tools.ts`).
6. Serve: the Discord adapter (`npm start`), or the MCP server on stdio (`node src/main.ts mcp`).

## Runtime graph

```text
Discord adapter            adapter/discord.ts, behind adapter/adapter.ts
  → MessageAggregator      aggregator.ts: a burst from one person in one channel is one question
  → Controller             pipeline.ts handle(): one question per session at a time
  → QueryPool              pipeline.ts: CONCURRENCY questions at once
  → Pipeline stages        pipeline.ts: reply 3, access 12, filter in 13, command 4, rate 5,
                           cite 10 and expose 17, ground 6, compute once, community decision,
                           history 16, answer with tools 15, level 7, filter out 13, long text 14
  → Providers / tools      providers.ts tool loop, tools.ts MCP client
  → records and event      records.ts: context record, answer record, CloudEvent
  → response via adapter   adapter/adapter.ts payloads: send, split or file
```

The improvement loop ([docs/improve.md](docs/improve.md)) turns use into knowledge, tests and an evolving genome of settings, and members' `/feedback` into requests filed to the community; every step is a kernel decision and a BLAKE3-labelled record.

Chaos experiments ([docs/chaos.md](docs/chaos.md)) run a shadow of the same pipeline in production: faults at the network, writes kept in memory, answers sent nowhere. The kernel runs only experiments the community approved by BLAKE3 label, never on live traffic, and stops one when a real question is waiting.

The MCP server is a parallel entrypoint into the same pipeline:

```text
MCP client → src/main.ts mcp (stdio) → mcp-server.ts tools → pipeline on the mcp surface
```

## Message flow

1. The Discord adapter turns an event into facts: the channel's kind, visibility and label, the install, the intent, the author's role, the trigger.
2. The aggregator folds quick follow-up messages from the same person in the same channel into one question.
3. The controller runs one question per session at a time; the pool caps the total.
4. The pipeline asks the kernel at each stage. A stage the kernel stops ends the turn: silence, or a typed refusal.
5. Retrieval finds candidates; the kernel decides which may be cited and, on the MCP surface, withholds every private item.
6. The answer key, a BLAKE3 label of everything the answer depends on, reuses an answer computed before.
7. A reply to Q builds on the same author's recent turns, each admitted by the kernel.
8. The language model writes the answer, calling MCP tools the kernel allows.
9. The turn leaves a context record, an answer record and a public event; the adapter sends the reply as the kernel decided.

## Platform layer

`host/src/adapter/`. `adapter.ts` is the interface every platform implements; `discord.ts` is the one implementation. An adapter translates platform events into facts and sends replies. It holds no pipeline rules and no policy: adding a platform is adding an adapter, and the kernel does not change.

## Pipeline layer

`host/src/pipeline.ts`. LangBot's stage families, each a kernel decision: response rules (3), banned sessions as access control (12), content filters in and out (13), rate limits (5), command handling (4), long text (14), plus Q's own: citation (10), exposure (17), grounding (6), claim level (7), source trust (8), history (16), community decisions. Message truncation is the retrieval and prompt caps.

## Providers, RAG and tools

- `providers.ts`: language models behind one interface, each with a tool loop, a call gate (`LLM_CONCURRENCY`) and retry on 429 and 503; OpenAI-compatible embeddings.
- `knowledge.ts`, `search.ts`, `store.ts`: sources (community, uor.foundation, GitHub, Discord), chunking, hybrid keyword and vector search, and the store of record by BLAKE3 label.
- `tools.ts`: the MCP client. Every tool of every configured server is offered; the kernel decides every call (15).

Do not confuse Q's MCP client (`tools.ts`) with Q's own MCP server (`mcp-server.ts`).

## The kernel

`app/src/Policy.lex.tex` holds the decisions and their theorems; `app/src/Contract.lex.tex` the byte dispatcher and its acceptance vectors. The host reaches it only through `host/src/kernel.ts`, which encodes facts into an eight-byte request. In LangBot a stage's rule is code; in Q it is a theorem Lean has proved.

## Agent-facing surfaces

- The MCP server (`mcp-server.ts`): `ask`, `search`, `status`, `community_apps`, `community_decide`. Public items only (DA-22).
- `AGENTS.md`, the template's rules for any agent working here, and the Prism skill in `.agents/skills/prism`.
- `ARCHITECTURE.md` and `docs/`.

When one of these changes, update the others. Drift is a bug.

## Persistence

- The store of record: a folder, or the Kappa Registry. Items by BLAKE3 label, typed edges with the registry's relation names. Discord items and turn records are private.
- The search index: SQLite, derived from the store and rebuildable from it, including the answer memo.

## Where to change things

- New platform: a new adapter in `host/src/adapter/`, implementing `adapter.ts`.
- New rule: a decision and its theorem in `app/src/Policy.lex.tex`, its dispatcher and vectors in `app/src/Contract.lex.tex`, a row in `model/ids.toml`, a scenario in `features/suites/`, then the kernel call in `host/src/kernel.ts`.
- New model provider: `host/src/providers.ts`.
- New knowledge source: a `Source` in `host/src/knowledge.ts`.
- New MCP tool for other agents: `host/src/mcp-server.ts`, public items only.
- New chaos experiment: a `uor-q/experiment/1` record in `experiments/`; it runs once the community approves its BLAKE3 label ([docs/chaos.md](docs/chaos.md)).

## Design biases

- If a line of host code holds an `if` about policy, it belongs in the kernel.
- One identity for everything: a BLAKE3 label.
- One source for the community's rules: its own signed holo.
- Keep platform translation, pipeline orchestration and provider execution separate, as LangBot does.
