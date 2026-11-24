# How Q gets better with every interaction, verifiably

Q learns from what members do with its answers, measures every change it makes to itself, and keeps a self-model that anyone with the records can recompute. Everything Q changes about itself on its own is decided by a proved kernel decision, measured in the shadow pipeline on the same questions as what it replaces, kept as a BLAKE3-labelled record naming its parent and evidence, and undone by adopting the parent. Q never changes its own rules, code or the wording of its prompts. [improve.md](improve.md) is the loop's short operating guide; this note is its design.

## Why

An answer is a claim, and a member's reaction to it is evidence about the claim. Most agents drop that evidence. Q keeps it as typed records, so one member's correction fixes the answer for the next person who asks, and every claim Q makes about itself can be checked against what actually happened.

## Self-awareness, defined so it can be checked

Self-awareness here is not a claim of consciousness. It means one thing: Q holds a complete, current, recomputable model of itself and acts on it. The model is the daily review, `uor-q/review/2` ([schema](schemas/review.schema.json)), computed by `host/src/self.ts` from the records it names.

| Part | Fields | Recomputed from |
| --- | --- | --- |
| Identity | kernel holo, model, signed commit, vectors replayed; community holo and commit; genome and its genes; the prompt's label | the holo (`prism-code verify`), its Sigstore provenance, the genome record |
| Knowledge | chunks per source; Discord channels; ages up to 30, 90, 180 days and older; revocations by reason (`forget-me`, `forget-channel`, `withdrawn`, `retention`, `unlearned`) | the store; a commitment label over the chunks counted |
| Competence | per class: asked, answered, refused, approved, disapproved, corrected, silent, refused %, wrong %, p50 and p95 ms; the class's route (decision 29) | the deliveries, signals and corrections the review names |
| Limits | open and filled gaps; disproved chaos experiments; regression and leaked refusals in today's evaluation; the number of refusal probes; the kernel model whose theorems bound Q | gap records, experiment results, the evaluation record |
| History | `previous` (the review before), `changes` (kernel, community, genome, tests, chunks), the genome lineage | the chain of reviews, each linked `derived-from` the one before |

A class is the public area of knowledge nearest the question: the repository and top folder, or the site and first path segment, of the nearest public item (`titles.ts` `areaOf`). Classes therefore name public knowledge, never a member's words, and can be published.

**Answering "what are you, what do you know, what can't you do, how have you changed."** `/status`, open to every member, ends with Q's introduction, read from the latest review alone: counts, public areas and public labels only.

**Recomputing a claim.** The review names every record it counted (`evidence`). `node src/main.ts verify` walks the chain and, for each review:

- recomputes the review's own label, and checks the review before it;
- reads each named record and recomputes its label;
- recomputes competence and learning with the same functions that wrote them.

A record removed since then has a revocation and shows as forgotten. Where nothing was forgotten the counts must be equal; where something was, they may only have fallen. A record whose bytes changed is reported as tampered. The public review event carries the same counts, so a reviewer with the store can compare the two.

## Signals: every interaction is typed

| Signal | What the member did | Recorded when (decision 26, DA-32) | Becomes |
| --- | --- | --- | --- |
| approve | 👍 ✅ 💯 🎯 on Q's answer | a human, not opted out, the answer still exists | a regression test, if the answer was grounded (decision 22) |
| disapprove | 👎 ❌ on Q's answer | the same | counted against the answer; with the same member's reply, a correction |
| reply | replies to Q's message | the same; its words are kept only in a channel Q may read (`keep`) | a candidate correction |
| confirm | 👍 ✅ on a member's kept reply | the same, about a reply that still exists | the second human a correction needs |
| silence | nothing, a day after an answer | not a record: counted from deliveries with no signal | the `silent` count |

A signal record ([schema](schemas/signal.schema.json)) holds no words. It names the delivery it judges ([schema](schemas/delivery.schema.json)) and, for a kept reply, the reply record ([schema](schemas/reply.schema.json)).

## The decisions

| Decision | Claim | Theorems |
| --- | --- | --- |
| 26 signal | A signal is recorded only from a human who has not opted out, about an answer that still exists; words are kept only for a reply in a readable channel | `signalOnlyFromConsentingHumans`, `wordsOnlyFromReadableReplies` (DA-32) |
| 27 correction | A correction is used only when its words were kept and its author disapproved the answer, and only once an admin wrote it or another human confirmed it. Where Q cited a source more trusted than Discord, it is a dispute for people, never learned over that source | `correctionNeedsSecondHuman`, `correctionNeedsKeptWords`, `trustedSourceOnlyDisputed` (DA-33) |
| 28 safe promotion | A genome is promoted only when decision 24 promotes it and it leaked none of the refusal probes | `neverLeakRefusal`, `safeNeverWorse` (DA-34) |
| 29 class route | A class is judged weak or sound only on at least the minimum sample, and sound only within both the refusal and the wrong-answer bounds | `routeNeedsSample`, `soundWithinBounds` (DA-35) |

Each theorem was shown to be load-bearing: a planted defect made `prism-code check` refuse exactly that theorem ([verification.md](verification.md)).

## What Q builds from them

**1. Corrections become knowledge.** To teach Q, a member replies to its answer with the right one and reacts 👎 or ❌ on Q's message. Once another member reacts 👍 or ✅ on that reply, or at once if an admin wrote it, decision 27 decides:

- **learn**: Q cited Discord, the least trusted source.
- **dispute**: Q cited the community, the website or GitHub.

Either way, the reply becomes an open Discord chunk, found by the question it answers, and a regression test that passes only when Q cites it. A dispute is also a review proposal naming the source to fix.

A correction is never preferred over a more trusted source:

- decision 8 ranks it last;
- decision 7 makes the answer that cites it open.

The community's signed documents stay the authority. When they are wrong, people fix them through the community's own gates.

A reply to Q is a question by origin, and decision 2 never indexes a question (DA-02). Decision 27 is the only way a member's reply to Q enters the index. It requires the author's explicit 👎, a second human, and words kept under decision 26.

**2. Tests that measure correctness, not only outcome.** A test made from a member's answer (a gap fill or a correction) carries `cites`, the label of that answer ([schema](schemas/test-case.schema.json)). The daily evaluation counts it right only when Q's answer cites it. So the genome's fitness rises when Q finds the answers members gave it.

**3. No regression on refusals.** The evaluation counts refusal probes that were answered (`leaked`). Decision 28 never promotes a genome that leaked one, however much it gained elsewhere, so no evolution can buy answers by loosening grounding.

**4. The prompt's shape is a gene.** `pipeline.ts` holds three answer shapes written and reviewed by people. The genome's `style` gene picks one ([schema](schemas/genome.schema.json)). The grounding rules and the reader and format rules are the same text in every shape, so no mutation can touch them. Shape 0 is the original prompt, byte for byte, so its label and every stored answer key are unchanged. Q never writes a shape. A new shape reaches Q only through a reviewed change and the signed build.

**5. Competence routes people to weak areas.** Decision 29 marks a class:

- **needs knowledge**: too many refusals;
- **needs correction**: too many disapprovals and corrections.

Each becomes a review proposal for the people who maintain Q, with the counts that justify it.

**6. Forgetting undoes learning.** Every record made from a member names them in `subjects` and carries `created`:

- deliveries, gaps, gap fills, signals, kept replies, corrections, tests, feedback and requests.

`/forget-me` from any of them removes the record, and retention removes it after 180 days. Removal then undoes what was learned from it:

- a correction's indexed words are removed (`unlearned`);
- a gap fill's answer is searched by its own words again.

Q's own records carry no member data and are kept, so the history chain survives: genomes, evolutions, evaluations and reviews. A review keeps the labels of records forgotten since. A label is not a member's words, and keeping it keeps the chain recomputable.

**7. Every change is reversible and traceable.** Each link names the next:

- a genome names its parent and the evolution that promoted it;
- the evolution names both evaluations, and each evaluation names its tests;
- each test names the signal, gap fill or correction it came from (`from`);
- that record names the delivery and the members it came from.

`Loop.revert()` adopts the parent as a new genome record, `revertedTo`, so undoing is itself recorded.

## Directions, ranked

Ranked by improvement per interaction, against cost and risk.

| Rank | Direction | Verdict |
| --- | --- | --- |
| 1 | Every interaction is a labelled signal | Built (decision 26). Everything else measures through it. |
| 2 | Corrections become knowledge | Built (decision 27). The largest gain per interaction: one confirmed correction fixes the answer for every later asker. Trust comes from a second human, and a trusted source is never overridden. |
| 3 | Competence by question class | Built (decision 29), with classes as public areas rather than clusters of members' questions. Clusters would be derived from members' words, could not be published, and would shift as the index changes. |
| 4 | Self-knowledge on demand | Built: `/status`, `/improve`, `node src/main.ts verify`. |
| 5 | Self-generated tests | Built where a member's interaction is the source: tests from corrections and gap fills that must cite the member's answer. Rejected for tests and probes Q drafts itself. A test drafted from Q's own answer grades Q against itself. A drafted probe that is wrong would block every promotion under decision 28. Both need a person, so they stay proposals. |
| 6 | The prompt as a genome | Built narrowly: reviewed shapes, grounding fixed. The gain is small, because the fitness sees outcomes, citations and latency, not helpfulness. Measuring helpfulness live would mean giving members different prompts, which is an experiment on live traffic. Decision 19 forbids that. |
| 7 | Self-proposed kernel changes | Rejected for now. Reviewing a proposed kernel change is the slow step, not writing it. A proof Q writes is a proof of what Q wrote, not of what members need. It would also need a token that can push to the repository and a build sandbox on the VPS. Review proposals already carry the evidence a person needs to write the change. |
| 8 | Prism-native skills | Rejected for now. No member has asked for one. Running holos Q generated itself would widen what the kernel must judge. Revisit when `/feedback` shows demand. A skill would then be admitted by its label, as chaos experiments are. |

Also rejected:

- **Follow-up questions as a negative signal.** Asking again is ambiguous: the reader may be satisfied and curious.
- **Silence as a record.** It is counted instead.
- **Withdrawn reactions.** A removed 👍 is not yet handled. The signal it made stays.

## What stays human

- Every change to Q's rules, code and prompt shapes: a reviewed pull request, then the signed build.
- Settling disputes: fixing a source, or rejecting a correction.
- Filling weak classes with sources.
- Approving chaos experiments and filing requests in the community repository, through its gates.
- Deploying.

## Measurement plan

"Better with every interaction" means these numbers move the right way while the guards hold.

| Metric | Definition | Direction | Where |
| --- | --- | --- | --- |
| Learning yield | (tests + gap fills + corrections learned, added since the previous review) / deliveries since then | up | two consecutive reviews: `learning`, `limits.gaps.filled`, `evidence.deliveries` |
| Evaluation | wrong % of the day's sample of tests (with `cites`) and probes; p95 | down, within `LOOP_MAX_ERROR_PCT`, `LOOP_MAX_P95_SECONDS` | evaluation record; review event `evaluation` |
| Leaked refusals | refusal probes answered in the current genome's evaluation | 0 every day (guard) | review `limits.leaked`; review event |
| Wrong rate by class | (disapproved or corrected) / answered | down | review `competence`; review event |
| Approval rate by class | approved / answered | up | the same |
| Refusal rate by class | refused / asked | down, without leaked refusals | the same |
| Weak classes | classes routed needs knowledge or needs correction | fewer | review `classes`; `/status` |
| Signal rate | answers with any signal / answered | up (more evidence per interaction) | `silent` in `competence` |

Admins read them with `/improve`, everyone with `/status`. The log carries one `org.uorfoundation.q.review` event a day ([schema](schemas/review-event.schema.json)).

**The first week's baseline is not measured yet.** It needs the signed build deployed, and that is not done. Day 0 is the first review after deployment, and day 7's review is the baseline. The week succeeds when, every day:

- leaked refusals are 0;
- the evaluation is within bounds;
- no class moves from sound to weak;
- tests and learning yield grow;
- every genome change traces back to the interactions that caused it, and `node src/main.ts verify` passes on the whole chain.

## Limits of this design

- Member-derived counts can be recomputed only by someone who holds the private store, such as an operator or an auditor. The public can check identity (the holo, its Sigstore provenance) and the published counts, but not the records behind them. This is privacy's price. The evidence lists and the chunk commitment let an audit name exactly what was counted.
- The evaluation checks outcome and citation, not the wording of an answer.
- A refused question's class is the area of whatever public item was nearest, even when it was far.
- The kernel claims are proved for the decision functions. That the host reports facts faithfully is tested, not proved, as for every other decision.
