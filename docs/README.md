# Architecture owner register

This is the canonical architecture-owner index referenced by [ARCHITECTURE_INDEX.md](../ARCHITECTURE_INDEX.md). The existing source and design references below are a navigation inventory, not owner appointments or accepted ADRs. Scoped architecture ownership and acceptance remain NOT_ESTABLISHED.

## Current architecture navigation

| Area | Existing design and source references | Owner / acceptance |
| --- | --- | --- |
| Model, proof and conformance | [Architecture](../ARCHITECTURE.md), [policy model](../app/src/Policy.lex.tex), [ID register](../model/ids.toml), [scenarios](../features/suites/), [generated conformance](../CONFORMANCE.md) | NOT_ESTABLISHED |
| Host, Discord and command effects | [Architecture](../ARCHITECTURE.md), [LangBot map](langbot.md), [Discord adapter](../host/src/adapter/discord.ts), [pipeline](../host/src/pipeline.ts), [capability map contract](capabilities.md) | NOT_ESTABLISHED |
| Web and MCP surfaces | [Web protocol](web.md), [MCP server](../host/src/mcp-server.ts), [tool client](../host/src/tools.ts) | NOT_ESTABLISHED |
| Context, privacy and provenance | [Context contract](context.md), [schemas](schemas/), [memory](../host/src/memory.ts), [provenance](../host/src/provenance.ts) | NOT_ESTABLISHED |
| Improvement, community and experiments | [Improvement](improve.md), [self-improvement](self-improvement.md), [chaos](chaos.md), [community](../host/src/community.ts), [apps](apps.md) | NOT_ESTABLISHED |
| Verification and delivery | [Verification](verification.md), [native CI](../.github/workflows/ci.yml), [signed holo workflow](../.github/workflows/holo.yml) | NOT_ESTABLISHED |

Some design documents describe older implementation states; use revision-bound model, code and native acceptance evidence to distinguish current behavior from historical design prose. Do not treat this inventory as acceptance or as a second source of modeled claims.

## Owner actions

An authenticated owner must identify scoped architecture owners, accept or supersede design decisions and bind those decisions to revision-specific evidence. Until then, route authority-dependent changes through [repository governance](../GOVERNANCE.md) and [issue #6](https://github.com/UOR-Foundation/q/issues/6).
