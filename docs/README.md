# Architecture owner register

This is the single canonical routing register referenced by [ARCHITECTURE_INDEX.md](../ARCHITECTURE_INDEX.md). Begin here before planning a change. The **source owner** is the file that owns the stated type of claim, not an appointed human or a blanket source of truth. Q's sole CODEOWNER is recorded in [MAINTAINERS.md](../MAINTAINERS.md); scoped human design acceptance, policy delegation and amendment authority remain NOT_ESTABLISHED. Do not infer them from this index.

Initial inventory inspected at [38b7dcdc](https://github.com/UOR-Foundation/q/tree/38b7dcdca174efebdff7f5e2ab2aebe4d06953e5); the table includes this change's maintenance test. Subsequent changes must maintain the same register in their own revision, not carry this initial observation forward as qualification.

## Canonical routing

The authoritative model governs decisions; schema/source govern observed implementation; exact-revision executed verification governs qualification; actual release or deployment receipts govern published reality. Proposals and historical documents are not accepted architecture. Cross-references outside the table do not create additional owners.

<!-- architecture-inventory:start -->
| ID | Area | Claim type and boundary | Primary source owner | Supporting contracts, implementation and evidence |
| --- | --- | --- | --- | --- |
| GOV | Governance and authority | Policy and review routing; appointments and enforcement are separate | [GOVERNANCE.md](../GOVERNANCE.md) |  |
| MODEL | Kernel policy and model contract | Normative model, locked template, claim register, proof inputs and generated conformance | [app/src/Policy.lex.tex](../app/src/Policy.lex.tex) |  |
| DESIGN | Architecture and host design | Design description; source determines implemented behavior | [ARCHITECTURE.md](../ARCHITECTURE.md) |  |
| START | Host startup and deployment | Composition, configuration and operator entrypoints; deployment not inferred | [host/src/main.ts](../host/src/main.ts) |  |
| DISCORD | Discord and response orchestration | Platform admission, aggregation, response and delivery effects | [host/src/pipeline.ts](../host/src/pipeline.ts) |  |
| WEB | Public web and agent interfaces | Public protocols and declared MCP service surface | [docs/web.md](web.md) |  |
| TOOLS | Inference and external tool effects | Provider execution and tool mediation; policy remains in model | [host/src/tools.ts](../host/src/tools.ts) |  |
| MEM | Knowledge, memory and data contracts | Storage, retrieval, records and privacy lifecycle; no deletion guarantee from index | [docs/context.md](context.md) |  |
| COMM | Community authority and provenance | Signed source admission and verification | [host/src/community.ts](../host/src/community.ts) |  |
| FOCUS | Live contribution discovery | Bounded public evidence and advisory recommendations; preview, operational acceptance separate | [docs/focus-governance-discovery.md](focus-governance-discovery.md) |  |
| LEARN | Feedback, evaluation and experiments | Governed learning, self-model and shadow execution | [docs/improve.md](improve.md) |  |
| TRACK | Community work tracking | Tracked open items; human-confirmed closure | [docs/tracker.md](tracker.md) |  |
| BUILD | App builder | Model generation and external builder service | [docs/apps.md](apps.md) |  |
| VERIFY | Qualification and publication | Executed evidence and workflows; not deployment or owner approval | [docs/verification.md](verification.md) |  |
<!-- architecture-inventory:end -->

## How to maintain the register

1. Before work, read the applicable primary owner, supporting contract and relevant governance. Record the affected area IDs, expected revision and dependent interfaces in the PR. Review source/decision conflicts with the authorized owner; do not silently rewrite an accepted claim to match implementation.
2. Add, move, remove or supersede architecture-bearing files in the same change as their registration. A supersession requires the old claim, replacement, scope, decision authority, effective revision/date, reason and affected evidence. Preserve useful history. Revalidate affected contracts and downstream tests.
3. Run the architecture inventory test from a Git checkout: `cd host && node --test test/architecture-index.test.ts`. It checks all tracked and nonignored untracked scoped paths, exact unique registrations and the single root pointer. The existing `npm test` CI step runs this test on PRs and main. No extra runtime dependency. A structural pass does not prove semantic correctness, review authorization or effective required-check enforcement.
4. Review changes to existing file contents as well as additions: file inventory checks cannot detect every semantic drift. Each PR must explicitly assess affected architecture, update its owner documents when claims change, and record actual native qualification. Review scope, not just link counts. See [CONTRIBUTING.md](../CONTRIBUTING.md).
5. Keep confidential evidence out of public docs. Record unresolved owner decisions in [#6](https://github.com/UOR-Foundation/q/issues/6); the standing authorization and information-boundary assurance program is [#13](https://github.com/UOR-Foundation/q/issues/13). Do not treat these as alternate architecture registers.

Scope: model and application inputs, host source/config/deploy/tests/benchmarks, public protocols, docs, schemas, experiments, prompts, governance and delivery workflows. Brand assets, generic repository metadata, generated/ignored build outputs and historical Qortara initialization/action records are not architecture owner entries. The latter remain discoverable through [template pin](qortara-template-pin.json) and [open external lock action](qortara/governance-actions/external-instruction-lock-8931c560d6673f1b327e.json). Neither is rewritten here.

## Current unresolved architecture and governance boundaries

- **Authority:** code-review routing exists; accountable policy and architecture acceptance scopes remain unestablished. Resolve through #6 rather than appointing people by inference.
- **Lifecycle:** instructions require native Qortara repository-document, architecture-index and lifecycle checks. Current hosted integration evaluates supplied inputs only; the existing CI runs Prism and host tests, not the Qortara runtime. The external instruction-lock action remains open. Preserve locked instructions and journals; reconcile with the originating template and owner. This local structural test supplements, not substitutes for, those required checks.
- **Enforcement:** inherited main protection is active; required native `verify` enforcement remains pending in #6. A green run is not proof of an enforced gate.
- **Release:** Focus is a default-off preview; #11 tracks operational acceptance. No claim that a signed kernel publication deploys the Discord host.
- **Security intake:** private reporting enabled per contributor confirmation; independently verified delivery and delegated triage remain open. See SECURITY.md and #6.
