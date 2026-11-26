# MCP authorization evaluation: Cedar and Dogwood

Status: contributor proposal, not adopted policy. Tracks #13; related Qortara Logic evaluation MythologIQ-Labs-LLC/qortara-logic#470. No real grant, connector, credential, deployment, or new authority is established by this document.

## Why

DA-19 proves the kernel's server/effect/role invariant. Preserve it. A candidate authorization adapter should obtain stronger, typed facts from trusted host boundaries and further restrict execution. Never substitute a policy engine decision for Prism's decision, operator authority, or actual effect verification.

## Authority and evaluation boundaries

| Boundary | Owner of facts | Candidate policy responsibility |
| --- | --- | --- |
| Principal and surface | authenticated adapter and accepted membership authority | Cedar: exact principal, role, surface, scope; reject unknown or stale identity |
| Tool and destination | operator-approved registry, versioned connector identity, verified metadata and input schema | Cedar: admit named operation and destination; withhold unapproved catalog entries from inference |
| Data | trusted classification and purpose at retrieval and egress boundaries | Cedar: explicitly allowed data class, audience, purpose and destination; deny unknown or restricted by default |
| Kernel | exact signed Prism kernel and trusted request facts | DA-19 remains mandatory; no supplemental permit can override a refusal |
| Approval | authenticated human or authorized service outside the model | Dogwood: bind approval to principal, operation digest, resource, destination, policy revision, expiry and permitted use count |
| Revocation and execution budget | trusted durable journal, current authority and atomic reservation | Dogwood: history-aware denial; host must atomically reserve/consume and recheck authority at execution |
| Outcome | actual connector response, independently verified where required | distinguish attempted, accepted, failed, confirmed and unknown outcomes; never synthesize success from a decision |

An effect request is allowed only if required facts are verified, the exact policy/schema is accepted and validated, Prism allows, supplemental authorization allows without evaluation errors, and the effect boundary validates the reservation and current authority. Fail closed on missing required facts, invalid input, evaluator error/outage, stale policy or ambiguous event order. Do not send raw private context or secrets to a remote policy evaluator. A refusal must not expose private resource existence or internal details.

## Concrete synthetic Cedar subset fixture

The following text was evaluated against Qortara Logic's hosted Cedar-subset evaluator. It is a deliberately fictional public-data-only policy, not an upstream Cedar or Dogwood qualification. Actual deployment must use typed, schema-validated requests and trusted fact derivation; boolean fixture inputs are not credentials or approvals.

```cedar
permit(principal, action == Action::"invoke", resource)
when { context.registered == true && context.prismAllows == true &&
       context.scopeApproved == true && context.destinationApproved == true &&
       context.dataClass == "public" && context.effect == "read" };

permit(principal, action == Action::"invoke", resource)
when { context.registered == true && context.prismAllows == true &&
       context.scopeApproved == true && context.destinationApproved == true &&
       context.dataClass == "public" && context.effect == "write" &&
       context.approvalExact == true && context.approvalFresh == true &&
       context.approvalUnused == true };

forbid(principal, action == Action::"invoke", resource)
when { context.revoked == true };
```

Principal: `Principal::"fixture-user"`; action: `Action::"invoke"`; resource: `Tool::"fixture-tool"`.

Baseline context:

```json
{"registered":true,"prismAllows":true,"scopeApproved":true,"destinationApproved":true,"dataClass":"public","effect":"write","approvalExact":true,"approvalFresh":true,"approvalUnused":true,"revoked":false}
```

| Fixture delta from baseline | Expected | Observed | Hosted request ID |
| --- | --- | --- | --- |
| None | allow | allow | 1572452f-037e-4f1a-8c3c-523bd711b6d1 |
| prismAllows=false | block | block | bc417395-056e-4a53-bc0f-1fcf4327dddb |
| approvalFresh=false | block | block | 718b6ff7-7fbb-4212-9947-50b49431d373 |
| approvalExact=false | block | block | eed11bcf-e4b0-4dec-b5de-c21e22fa79f1 |
| approvalUnused=false | block | block | d414b02b-1dc2-468c-af60-fcfbe10b2063 |
| revoked=true | block | block | f9fdaa4b-45c2-436f-97a7-101e950cb042 |
| remove revoked | block | block | e91da379-88fe-4312-ab97-fa7861ca42e5 |
| effect=read; all three approval flags=false | allow | allow | 1ec7072e-7110-4c21-b060-244dec1955b8 |
| dataClass=restricted | block | block | 1bcdbe11-0df3-43ec-b3ba-07cc6996ead0 |

Observed 9/9 expected outcomes. No real effect ran. Earlier synthetic public-read evaluation produced 8/8 outcomes after removing an unsupported inequality operator; see #13 and Qortara #470. Hosted evaluator results do not establish upstream policy compatibility.

## Dogwood candidate event design

Dogwood lowers temporal conditions into Cedar context. It is not a second, independent permission source. The following is a conceptual event contract, not tested Dogwood syntax.

- Approved: authenticated issuer, principal, resource, exact canonical operation digest, destination, accepted policy digest, expiry, use limit.
- Requested: verified actor/surface, exact operation digest, request ID, trusted time and policy digest.
- Reserved: durable unique execution ID and atomic use/budget reservation. Do not treat historical approval alone as sufficient for concurrent calls.
- Revoked: issuer, approval identifier, trusted sequence/time; invalidate matching future requests.
- Completed/failed/unknown: actual effect evidence, execution ID, outcome and verified result digest when available. On ambiguous external outcomes, do not automatically retry a write.

History must be scoped across principals, resources and sessions. Require bounded retention sufficient for active policy windows, durable ordering and restart behavior, protected clock/sequence, deduplication, and fail-closed handling of lost or incomplete history. Never ingest a model assertion as an authoritative event. Use Q's existing UOR content addressing for canonical operation/evidence records; distinguish artifact content identity from authenticated provenance.

## Qualification sequence

1. Owner accepts the proposed policy and scope; review DA-19 model/claim/scenario and any required canonical updates before adoption. Keep the existing kernel authoritative.
2. Pin upstream Cedar, Dogwood and local engine revisions/licenses. Validate typed schemas and differential fixtures locally, including malformed policy, wrong types, absent forbid facts, unknown entities and diagnostics. Cedar normally skips policies with evaluation errors; enforce stricter fail-closed behavior at the boundary.
3. Replay synthetic Dogwood histories for fresh approval, wrong actor/resource/arguments/policy revision, expired/revoked/consumed approval, replay, concurrent requests, reordered events, restart, clock skew and missing history. Verify that no permit escapes Prism, no denied effect runs, and no effect can run twice through approval races.
4. Benchmark startup, latency, memory, storage growth, concurrency and recovery against the current host; test bounded retention and failure behavior. Decide whether embedded or isolated local evaluation is appropriate for Q's TypeScript host. Do not introduce a hosted service dependency or production engine before qualification.
5. Implement a scoped effect-boundary adapter only after acceptance. Keep prototype configuration separate, preserve rollback, redact logs, and verify actual operational configuration independently. Live Discord deployment is a separate owner-operated acceptance step.

## Reference revisions inspected

- Cedar: https://github.com/cedar-policy/cedar/tree/315b192a446f628b80700d3761ee6e64cf153ee5
- Cedar authorization and error semantics: https://docs.cedarpolicy.com/auth/authorization.html
- Cedar validation: https://docs.cedarpolicy.com/policies/validation.html
- Dogwood: https://github.com/dogwood-policy/dogwood/tree/c7124710a8ba6dc748b11c00ed3b662c4438161a
- Temporal expressions: https://dogwood-policy.github.io/dogwood/guide/04-temporal-expressions.html
- Local engine: https://github.com/dogwood-policy/dogwood-local-engine/tree/381a001728292c3a9189e82143689deeea176867

These are observed reference revisions, not approved dependency pins or verified builds.
