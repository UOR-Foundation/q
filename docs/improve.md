# How Q improves itself

Q knows itself, learns from use, and evolves. Every step is measured, decided by Q's own proved kernel, and recorded under a BLAKE3 label. All of it runs on its own. The one thing Q never changes by itself is its own rules or code. An agent that could edit the theorems that bind it could weaken them, and CI would pass the weaker ones. Those changes reach Q only as proposals, and then only as a build its own workflow signed.

## Why

An agent that only answers stays as good as its first day. Q's members already know what it gets wrong, what it should know and what they want from it. The loop turns that into knowledge, tests and better settings, without anyone maintaining it by hand.

## How

| Step | What happens | Decided by |
| --- | --- | --- |
| Gap | A question Q refuses is recorded with the link to the question. | a fact of the turn |
| Fill | A member's reply to that question fills the gap. Q then finds the reply by the question it answers, so the next person who asks gets the member's answer, cited. | decision 21, `Policy.fillOnlyIndexedHuman` (DA-26) |
| Signal | A member's approval, disapproval, reply or confirmation on what Q said is a typed record naming what it judges. Only a consenting human's counts; a reply's words are kept only in a channel Q may read. | decision 26, `Policy.signalOnlyFromConsentingHumans`, `Policy.wordsOnlyFromReadableReplies` (DA-32) |
| Correct | A member replies to Q's answer with the right one and reacts 👎 or ❌ on Q's message. Once another member reacts 👍 or ✅ on the reply (or at once, from an admin), Q learns it, found by the question it answers. Where Q cited a more trusted source, it is a dispute for people instead. | decision 27, `Policy.correctionNeedsSecondHuman`, `Policy.correctionNeedsKeptWords`, `Policy.trustedSourceOnlyDisputed` (DA-33) |
| Test | A 👍 or ✅ on a grounded answer, a filled gap, or a learned correction becomes a regression test. A test from a member's answer passes only when Q cites it. | decision 22, `Policy.admitOnlyGrounded` (DA-27) |
| Measure | Once a day, Q asks a sample of its tests, plus questions it must keep refusing, in a shadow pipeline. The sample is drawn from BLAKE3 of the day. | decision 23, `Policy.evalYields` (DA-28); steady state by decision 20 |
| Evolve | Q's retrieval settings and the shape of its prompt, one of three shapes people wrote, are a genome: a record that names its parent. Q tries one mutation a day, drawn from BLAKE3, on the same questions. A mutation wins only if it is measurably better and answers none of the questions Q must refuse; Q adopts it at once, and adopting the parent undoes it. | decision 28 over decision 24, `Policy.neverLeakRefusal`, `Policy.safeNeverWorse` (DA-34) |
| Classes | Questions are classed by the public area of their nearest public item. A class with too many refusals or wrong answers becomes a proposal. | decision 29, `Policy.routeNeedsSample`, `Policy.soundWithinBounds` (DA-35) |
| Request | `/feedback` takes an idea, a problem or praise. A request like an open one supports it. Once enough members ask for it, it is filed to [UOR-Foundation/community](https://github.com/UOR-Foundation/community) as an issue: without names, once, and found again by its label. | decision 25, `Policy.fileOnlyConsented`, `Policy.fileOnlyWithSupport` (DA-30) |
| Review | Once a day, Q writes its self-model: identity, knowledge, competence by class, limits, learning and what changed, every count computed from the records it names, plus its proposals. Each review names the one before it by its label, so the chain cannot be rewritten. | a record, `uor-q/review/2`; its public event carries counts only |

Anyone reads who Q is with `/status`; admins read the latest review with `/improve`. `node src/main.ts verify` recomputes every review in the chain from its records. The design, the self-model's fields and the measurement plan are in [self-improvement.md](self-improvement.md).

## What it needs

- Filing requests to the community needs `COMMUNITY_ISSUES_TOKEN`: a token that can open issues in UOR-Foundation/community and nothing else. Until it is set, requests are kept and wait, and `/improve` lists them.
- `REQUEST_THRESHOLD` sets how many members must ask before a request is filed (2 by default). `LOOP_EVERY_HOURS`, `LOOP_EVALUATION_SIZE`, `LOOP_MAX_ERROR_PCT` and `LOOP_MAX_P95_SECONDS` tune the loop. `LOOP_MIN_CLASS` (10), `LOOP_MAX_REFUSED_PCT` (50) and `LOOP_MAX_WRONG_PCT` (20) bound decision 29. `PROMPT_STYLE` (0) is the answer shape the first genome starts from.
