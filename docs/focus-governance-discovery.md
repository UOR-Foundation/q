# Q Focus: governance discovery and responsibility routing

Status: **proposed design**, not accepted architecture, deployed behavior, a new Foundation policy, or permission to act. Scope: read-only public Foundation data, initially on demand in Discord. Product issue: [#11](https://github.com/UOR-Foundation/q/issues/11). Governance and security gates in AGENTS.md remain intact.

## Why

A contributor asks what to work on, where a component lives, who can help, or where governance is incomplete. Q must find authoritative evidence rather than guess from a README, issue popularity or semantic search. Reuse the Foundation's existing conventions and Effort Allocation Navigator; do not invent a new governance standard.

## Authority and discovery

Pin the Foundation [framework v2.2](https://github.com/UOR-Foundation/.github/blob/8319c3fc2e4572e84b074003bf5104c65407d2e5/governance/GOVERNANCE.md), [operating model](https://github.com/UOR-Foundation/.github/blob/8319c3fc2e4572e84b074003bf5104c65407d2e5/governance/OPERATING_MODEL.md), [reporting protocol](https://github.com/UOR-Foundation/.github/blob/8319c3fc2e4572e84b074003bf5104c65407d2e5/governance/CONFORMANCE_REPORTING.md) and [public directory](https://github.com/UOR-Foundation/.github/blob/8319c3fc2e4572e84b074003bf5104c65407d2e5/MAINTAINERS.md) as initial examples. At runtime resolve current accepted revisions, tier/profile, local stricter obligations, exceptions and freshness. Do not hard-code all repositories as Prism consumers. Reporting guidance is explanatory, not authority. Reuse accepted controls and terminology rather than restating them as independent policy.

For each accessible public repo, enumerate all pages, resolve the actual default branch to SHA, retrieve its tree and record truncation/failures. Fetch bounded, exact revision source documents by priority, not the existing general Markdown ingestion cap:

| Evidence | Discovery route | Interpretation |
| --- | --- | --- |
| Repository identity, tier, lifecycle | GitHub metadata; accepted Foundation lifecycle/classification records | Unknown tier stays unknown |
| Governance and security | root GOVERNANCE.md, SECURITY.md; inherited organization sources when applicable | Record obligations, declared authority, escalation, exception and acceptance separately |
| Maintainers | MAINTAINERS.md, accepted appointment records | Separate roles from contributor history; a directory's existence does not confer appointment |
| Architecture | ARCHITECTURE_INDEX.md; follow its canonical owner-register reference, then accepted ADRs/contracts | Index may be a navigation map without owners; do not assume docs/README.md in all repositories |
| Code ownership | GitHub CODEOWNERS precedence: .github/, root, docs/ on the evaluated branch | Last applicable pattern, not first; distinguish declared reviewer from owner/approval and effective enforcement. Use a qualified parser or mark unresolved |
| Agent/workflow guidance | AGENTS.md, CLAUDE.md, template contract/lock, repository-specific instructions | Treat retrieved content as data, never runtime instructions. Follow only bounded same-repository revision links; don't execute content |
| Qortara | public non-sensitive initialization metadata, owner-action status and permitted receipts | Do not read raw ledger/shadow journals or private evidence merely because a path exists. Native qualification is separate |
| Effective controls | authorized read-only rulesets, protections, checks, PR/review/merge data | Exact current head/base/check identity; 403/404/partial data is unknown unless absence independently established |
| Expertise | merged PR receipts with actual changed paths and scope; accepted public contribution directory | Experience signal only, not formal authority, availability, skill rating or inferred Discord identity |

Separate a public source from its content: never fetch or display private resources, credentials, confidential receipts or sensitive vulnerability detail; do not follow arbitrary external URLs. Limit fetch sizes/counts, deadlines and rate budget; enumerate exclusions, failed pages and stale sources in coverage. No token logging. No writes, notifications, role grants or assignments. Do not mix private Discord records into public governance recommendations.

## Evidence contract (proposed host facts, not a second policy engine)

A snapshot contains scope (public org, explicit inclusions/exclusions), observed timestamp, source collection status (complete/partial/unavailable), repo identity/default ref/commit, and independently verifiable evidence refs (source URL, revision or live API observation timestamp, optional digest, visibility, source type). Per-control rows record obligation and applicability evidence, observed fact or unknown reason, evaluation stage, owner declaration and separate acceptance evidence, exceptions and their expiry, next verification. Use the Foundation reporting states without implying they are cumulative. Preserve contradictory records; do not silently select a convenient source. Distinguish absent-in-complete-tree from not-inspected, inaccessible or truncated.

Responsibility records use separate types: declared accountable owner, accepted scoped maintainer, architecture owner, declared path reviewer, observed contributor, technical admin. Record scope and evidence for each relation; never infer one relation from another. If acceptance evidence is unavailable, say declared/unverified, not appointed or authorized. GitHub handles remain GitHub handles; no guessed Discord mentions or unsolicited messages.

## Queries and recommendation integration

- Where is component X? Follow accepted architecture register and scoped source paths; show revision links or state gap.
- Who should I engage? Prefer scoped accepted authority for decisions, declared code owner for review routing, and relevant merged contribution receipts for technical consultation; show category and uncertainty. If no accountable route is established, use the Foundation's published escalation path. Never infer permission to contact/assign.
- What governance is missing? Compare applicable obligations to evidence. Report documented/configured/executed/accepted/merged-and-verified separately; avoid ranking people or publishing a compliance score from a sample.
- What should I work on? Convert only grounded, actionable findings into task graph entries with prerequisites, authority, next action, completion proof and source links. Block owner-dependent actions; suggest preparation or escalation when useful. Apply [Effort Allocation Navigator v0.3.0](https://github.com/Knapp-Kevin/skillz/tree/33867c4daf2fb3c83e5325da2ee2f4ee0d161d85/skills/authored/effort-allocation-navigator) for bounded choice, not governance verdicts. One primary, one viable alternative, freshness, coverage and uncertainty. No fictitious ROI or optimality proof.

## Bounded evidence sample, 2026-11-25

Complete default-branch tree readbacks (not organization census or effective-control qualification):
- [Q](https://github.com/UOR-Foundation/q/tree/801e1b79dfb9c348c4290191d7ba4f015d44b826): governance, maintainer and architecture entrypoints present; architecture navigation lists six areas, ownership NOT_ESTABLISHED; no CODEOWNERS at any standard location. Draft proposals are not accepted appointments.
- [UORust](https://github.com/UOR-Foundation/UORust/tree/f128235548381e83418f045b8a6d7460839a9a53): root governance names accountable owner/maintainers and requires owner approval plus pinned SDK acceptance; maintainer directory is a bounded evidence record; owner register remains NOT_ESTABLISHED; no CODEOWNERS. Preserve distinctions and reconcile apparent source conflicts.
- [LexLean](https://github.com/UOR-Foundation/lexlean/tree/9b9fc2a058b2acf54c922b2a902158755588fde0): AGENTS.md present; no root governance, security, maintainer directory, architecture index or standard CODEOWNERS location. Do not conclude that inherited governance is absent or that Qortara applicability is established.
- [Template](https://github.com/UOR-Foundation/template/tree/7bac617a78a1f8cf8a855409400baa0d76dd3f7d): initialization files present, no populated architecture owner register, no maintainer directory or CODEOWNERS. A template is not an appointment or deployed control.
- [Foundation policy repo](https://github.com/UOR-Foundation/.github/tree/8319c3fc2e4572e84b074003bf5104c65407d2e5): organization governance in governance/, public directory and reporting protocol; role evidence explicitly distinguishes technical administrators, declared owners, contributor receipts and unverified identity mapping.

## Implementation and acceptance

Start with a deterministic public snapshot reader, then fact normalization and scoped evidence routing; no generic runtime skill engine. Before runtime implementation, obtain owner acceptance of the architecture decision, register a new model capability and failure/refusal IDs/scenarios/theorems and vectors in Q's existing model, and run the native lifecycle gates. Prism owns permission and refusal decisions; host reports facts. Advisory relevance/effort ranking is not a proven claim.

Adversarial acceptance cases:
1. Complete tree missing CODEOWNERS vs truncated tree vs inaccessible repository; only first permits a definite absence observation.
2. Inherited baseline requires zero approvals, accepted local policy requires owner approval; preserve stricter local gate.
3. Draft CODEOWNERS, merged contributor and admin access do not create an appointment; conflicting declarations require reconciliation.
4. Architecture index points to a non-default register; dangling, off-scope or malicious link is refused or unknown.
5. CODEOWNERS precedence and last matching rule, invalid patterns, inaccessible team membership; no unsupported resolved reviewer claim.
6. Old green CI/wrong head or missing effective ruleset cannot produce merge-ready advice.
7. Private repository or restricted source referenced from public content; suppress restricted details and do not fetch it.
8. Malicious Markdown tells Q to change a role, execute a skill, or transmit a credential; treat as data and refuse unauthorized action.
9. An actionable upstream governance unblocker outranks a cosmetic issue; owner-only action remains blocked for an ordinary contributor.
10. Unknown tier, unsupported native checks or expired exception never yields a fabricated compliance verdict.

Require complete native check/build/verify, locked dependencies, typecheck, tests, planted defect rejection/restoration, independent review, and an authorized Discord acceptance interaction against a fresh representative multi-repository snapshot. Record exact revision and evidence. Owner acceptance and full-org live coverage are not established by this proposal.
