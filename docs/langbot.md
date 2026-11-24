# Q and LangBot

Q takes [LangBot](https://github.com/langbot-app/LangBot)'s architecture, not its code (LangBot is Apache-2.0 Python; nothing here is copied from it). Each of LangBot's pipeline stages is one decision in Q's kernel, proved by Lean's kernel, and one thin step in the host that reports facts and obeys.

## Why

LangBot decides in code: a stage's `if` is the policy. Q's rule is that a policy `if` belongs in the model, so each stage's rule is a total function over a few bounded facts, with the guarantee that matters stated as a theorem.

## The map

| LangBot | Q's kernel | Q's host | Guarantee |
| --- | --- | --- | --- |
| Platform adapter (`platform/sources/discord.py`) | read (1), index (2) | `adapter/adapter.ts`, `adapter/discord.ts` | DA-01, DA-02, DA-13 |
| Response rules (`resprule`) | reply (3) | pipeline, first step | DA-03 |
| Access control (`bansess`) | access (12) | pipeline: is the channel, the author or `*` on `ACCESS_LIST` | DA-16 |
| Content filter, incoming and outgoing (`cntfilter`) | content filter (13) | pipeline: does the text hold a term of `FILTER_TERMS`, and the masked text | DA-17 |
| Rate limit (`ratelimit`) | rate limit (5) | pipeline: counters per user and channel | DA-05 |
| Command handling (`command`) | command (4) | pipeline: `/ask`, `/search`, `/status`, `/reindex`, `/forget-channel`, `/forget-me` | DA-04 |
| Message aggregator (`aggregator`) | none: it normalizes input | `aggregator.ts`: a burst from one person in one channel is one question (`AGGREGATE_MS`) | tested |
| Query pool and controller (`pool`, `controller`) | none: resource limits, not policy | pipeline: `CONCURRENCY` questions at once, one per session | tested |
| Conversation history (chat handler, Host-owned) | history (16) | pipeline: a reply to Q builds on the same author's recent turns (`HISTORY_MINUTES`) | DA-21 |
| Chat handler and runner, with tools (`provider`, MCP) | grounding (6), claim level (7), tool call (15) | `providers.ts` tool loop, `tools.ts` MCP client | DA-06, DA-07, DA-19 |
| Knowledge base (`rag`, `vector`) | source trust (8), citation (10), namespace (11) | `knowledge.ts`, `search.ts`, `store.ts` | DA-08, DA-10, DA-11 |
| Long text (`longtext`) | long text (14) | adapter: one message, split, or a file | DA-18 |
| Response back (`respback`) | none | adapter | tested |
| Model providers (`provider/modelmgr`) | none | Anthropic, OpenAI-compatible, Ollama | not run: Anthropic, Ollama |
| MCP server at `/mcp` (`api/mcp`) | exposure (17) | `mcp-server.ts` on stdio: `ask`, `search`, `status`, `community_apps`, `community_decide`; public items only | DA-22 |
| `ARCHITECTURE.md`, `AGENTS.md`, skills | none | `ARCHITECTURE.md` in LangBot's structure, the template's `AGENTS.md`, the Prism skill | |

What Q adds that LangBot has no stage for: retention and forgetting (9; DA-09), including what is deleted or edited on Discord; the rules reaction role that carl-bot gave as "UOR Bot" (18; DA-23), chaos experiments in production, approved by the community by BLAKE3 label (19, 20; DA-24, DA-25, [chaos.md](chaos.md)), the community root and its drift check (DA-13), community decisions (DA-14), and a record of every turn (DA-15).

## What Q leaves out

- Platforms other than Discord. Adding one is a new `Adapter`; the kernel does not change.
- The web admin panel and HTTP API. Administration is slash commands and configuration; other agents use the MCP server.
- Webhook pushing from the runtime bot, and per-bot configurable stage chains: Q's stage order is fixed, and each stage's rule is a proved decision.
- The plugin system and marketplace, and the sandbox.
- Multi-tenancy, voice, and LangBot's other forty-odd model providers. Most speak the OpenAI-compatible route Q already has.

## Where Q differs on purpose

- **Content filter.** LangBot's filters set a level; Q's host reports the level from a term list, and the kernel decides what it means at each stage, with LangBot's semantics: incoming masked or blocked content interrupts, outgoing blocked content interrupts, outgoing masked content goes out masked.
- **Long text.** LangBot renders long replies as images or forwarded messages. Discord has neither need, so Q splits up to five messages or attaches a file, and never sends one message over Discord's limit (DA-18).
- **Sessions and history.** A LangBot group chat is one session with one shared history. Q's session is a person in a channel, and history is used only when someone replies to Q: one member's conversation is never another's context (DA-21), and an ordinary question stays reusable by its answer key.
- **Tools.** LangBot offers every tool. Q offers every tool too, and the kernel decides every call: only on an allowlisted server, and a tool that writes only for the admin role (DA-19). A tool's result makes the answer open at most.
