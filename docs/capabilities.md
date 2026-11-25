# Capability map and provenance (DA-39)

The inventory is a measured host claim, not a new authority source or a proof of effective permissions. A model claim does not certify its whole host. The existing kernel decides command eligibility, exposure, rate limits and filtering; every actual operation still follows its own policy and host checks.

## Sources and maintenance

- `host/src/capabilities.ts` is the single Discord command description registry consumed by the adapter and the report. The kernel's closed command vocabulary remains authoritative; TypeScript and the native catalog coverage test must agree.
- Public capability groups describe existing implementation and cite model IDs and implementation paths. Update the catalog, registered claim/scenario and regression tests when a surface or operation changes. Do not invent authority from configuration or README claims.
- Report kernel model/holo and signed kernel commit (or unverified), community holo/commit and the content address of the canonical report. Kernel provenance is not a signed host revision. Until host identity is independently available, report it as not established.
- Wiring, command eligibility, actual effect authorization, operational qualification and proof are separate. The report has no per-user data, private tool identities, schemas, endpoints, secret settings, protected resource names, or knowledge contents. No new connector is invoked and no LLM is needed.
- Current report is Discord-only, with registered command coverage and declared public groups. It is not a complete effective-privilege inventory of every deployed surface. Web/MCP discovery and background operations need separate live qualification and audience-safe inventory. The existing `/status` report stays compatible.
- Govern changes using [the architecture register](README.md), [repository governance](../GOVERNANCE.md), the registered DA-39 host acceptance scenario and native tests. Review on added commands, new connectors, permission changes, data lifecycle changes or deployment changes. Broader authorization/data classification discovery is tracked in [#13](https://github.com/UOR-Foundation/q/issues/13); do not equate this map with that assurance program.

## Acceptance

Use a real kernel and isolated host fixtures for member/admin eligibility, missing optional handlers, catalog completeness, provenance label recomputation, access filters, restricted channel silence and no tool/LLM invocation. Plant a catalog omission and establish that the native gate fails, restore, regenerate conformance using pinned Prism and run complete CI. Record operational Discord verification separately; no fabricated evidence.
