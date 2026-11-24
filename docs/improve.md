# How Q improves itself

Q knows itself, learns from use, and evolves. Every step is measured, decided by Q's own proved kernel, and recorded under a BLAKE3 label. All of it runs on its own. The one thing Q never changes by itself is its own rules or code. An agent that could edit the theorems that bind it could weaken them, and CI would pass the weaker ones. Those changes reach Q only as proposals, and then only as a build its own workflow signed.

## Why

An agent that only answers stays as good as its first day. Q's members already know what it gets wrong, what it should know and what they want from it. The loop turns that into knowledge, tests and better settings, without anyone maintaining it by hand.

## How

| Step | What happens | Decided by |
| --- | --- | --- |
| Gap | A question Q refuses is recorded with the link to the question. | a fact of the turn |
| Fill | A member's reply to that question fills the gap. Q then finds the reply by the question it answers, so the next person who asks gets the member's answer, cited. | decision 21, `Policy.fillOnlyIndexedHuman` (DA-26) |
| Test | A 👍 or ✅ on a grounded answer, or a filled gap, becomes a regression test. A 👎 is counted against the answer. | decision 22, `Policy.admitOnlyGrounded` (DA-27) |
| Measure | Once a day, Q asks a sample of its tests, plus questions it must keep refusing, in a shadow pipeline. The sample is drawn from BLAKE3 of the day. | decision 23, `Policy.evalYields` (DA-28); steady state by decision 20 |
| Evolve | Q's retrieval settings are a genome: a record that names its parent. Q tries one mutation a day, drawn from BLAKE3, on the same questions. A mutation wins only if it is measurably better, and Q adopts it at once. | decision 24, `Policy.neverPromoteWorse`, `Policy.promoteNeedsGain` (DA-29) |
| Request | `/feedback` takes an idea, a problem or praise. A request like an open one supports it. Once enough members ask for it, it is filed to [UOR-Foundation/community](https://github.com/UOR-Foundation/community) as an issue: without names, once, and found again by its label. | decision 25, `Policy.fileOnlyConsented`, `Policy.fileOnlyWithSupport` (DA-30) |
| Review | Once a day, Q writes a self-portrait. It records who Q is (holo, model, signed commit, vectors, community pin, index, genome), its open gaps and requests, its tests, its evaluation, its chaos verdicts and its proposals. Each review names the one before it by its label, so the chain cannot be rewritten. | a record; its public event carries counts only |

Admins read the latest review with `/improve`.

## What it needs

- Filing requests to the community needs `COMMUNITY_ISSUES_TOKEN`: a token that can open issues in UOR-Foundation/community and nothing else. Until it is set, requests are kept and wait, and `/improve` lists them.
- `REQUEST_THRESHOLD` sets how many members must ask before a request is filed (2 by default). `LOOP_EVERY_HOURS`, `LOOP_EVALUATION_SIZE`, `LOOP_MAX_ERROR_PCT` and `LOOP_MAX_P95_SECONDS` tune the loop.
