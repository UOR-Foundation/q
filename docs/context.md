# Q's input and output

Q answers a question from three inputs and leaves three outputs. Every one of them has one identity: a BLAKE3 kappa label, `blake3:<64 hex>`. A file is labelled over its exact bytes; a JSON record is labelled by `@uor-foundation/uor-addr` after JCS and NFC canonicalization.

## Why

A Discord answer about a community's rules is only as good as the rules it was read from. If those rules can drift, or the answer cannot say which version it used, nobody can check it. So each answer names exactly what it was made from, and the community's own repository is the one authority for its rules.

## Inputs

| Input | What it is | Identity | How it is fixed |
| --- | --- | --- | --- |
| The kernel | Q's own decisions, seventeen of them | the label of `q.holo` | built by prism-code 0.11.2; at every start its 128 vectors replay, and its exact bytes must be a build that `UOR-Foundation/q`'s `holo.yml` signed from `main` (verified with Sigstore, as for the community); the context record names that commit |
| The community root | `UOR-Foundation/community`: its 35 decision apps, its channel labels, its documents | the label of the community `app.holo` | see below |
| The question | the text, the channel's facts, the author's role, the trigger | the label of the turn's context record | read by the Discord adapter; message text never enters the kernel |

### The community root

At start, and again on `/reindex`:

1. Fetch `https://uor-foundation.github.io/community/app.holo`. Label it.
2. Fetch GitHub's attestations for its SHA-256 and verify each SLSA provenance signature with Sigstore. The signer must be `UOR-Foundation/community/.github/workflows/pages.yml@refs/heads/main`. The subject must be these bytes.
3. Take the newest verified commit, by transparency-log time. The same bytes are often built from several commits; the newest is the community as it is now.
4. Load the holo and replay its 181 acceptance vectors.
5. At that one commit, read `apps/*.prompt.json`. An app enters Q's catalog only when the holo answers every example its prompt states, exactly.
6. At that one commit, read `governance/discord.json` for the channel labels: its default, and any channel it names.
7. Ask Q's kernel and the community holo all 96 read requests. If any answer differs, Q does not start.

Knowledge from the community is indexed at the same commit. Decisions, labels and knowledge cannot come from different versions of the community.

If the network is down, the last verified holo and its provenance are read from `COMMUNITY_CACHE_DIR` and verified again. A cached file is trusted no more than a fetched one.

## One turn

1. The kernel decides whether to reply (3), whether the session passes access control (12), whether the question passes the incoming content filter (13), whether the command is allowed (4), and whether the rate limit allows it (5). A question these stop leaves no records.
2. Retrieval finds candidate items. Each is read back from the store, its label recomputed, and the kernel decides whether it may be cited (10).
3. The kernel turns the best score into a grounding decision (6).
4. Compute once: the answer key is the BLAKE3 label of the normalized question, Q's kernel, the community pin, the admitted evidence in order, the prompts and the model. An answer computed before for that key, whose records still exist, is reused, and the reply says so.
5. If a cited item is a community decision app, the language model reads that app's inputs from the question. The community holo is asked only when every input is one the app's prompt allows. An input the question does not state is named back to the reader, never guessed. This runs while a plain answer is written, and the plain answer is kept when there is no decision.
6. The context record is written.
7. The language model answers. If MCP tools are configured it may ask for tool calls; the kernel decides each one (15). A call that runs leaves a `tool-result` item, private and named by its label, and makes the answer open at most.
8. The answer record and the event are written. When the model finds that the sources do not answer, the reply is a plain refusal with no claim level and no sources.
9. The reply goes through the outgoing content filter (13) and the long-text decision (14): sent, split, or attached as a file.

## Outputs

| Output | Schema | Where | Holds |
| --- | --- | --- | --- |
| Context record | [`uor-agent/context/1`](schemas/context.schema.json) | private namespace | the kernel and community labels, the question, retrieval's band and items, the decision asked |
| Answer record | [`uor-agent/answer/1`](schemas/answer.schema.json) | private namespace | the context's label, the grounding outcome, the claim level, the text, the citations |
| Event | [`org.uorfoundation.discord.answer`](schemas/event.schema.json), CloudEvents 1.0 | one JSON line on standard output | outcome, level, citation count, the app's name, the two holo labels |
| Reply | Discord message | the channel | the answer, then in subtext its claim level, the decision line, and the sources it cites |

The answer record is linked with the Kappa Registry's relations:

- `derived-from` its context
- `evidence-provenance` each citation
- `certified-by` Q's holo, and the community holo when a decision was answered

Both records hold a person's question, so both are private and are deleted by `/forget-me`, `/forget-channel` and retention. The event holds no question, no text, no author, and no label of either record, because a label confirms that a known message exists. Its id is the label of its own content.

A refusal is a turn too: both records and an event, with outcome `not grounded`.

## What is established, and how

| Claim | Level | Evidence |
| --- | --- | --- |
| Q's read policy answers all 96 requests as the community's does | open (DA-13) | measured at every start; a host test plants one difference and the check names it |
| A decision in an answer is the community holo's answer, asked only with every input read | open (DA-14) | host tests |
| Every turn leaves both records and a content-free event | open (DA-15) | host tests check every kind of turn against the three schemas |
| The community holo was built by the community's own workflow from the commit Q names | Sigstore verification of GitHub's SLSA provenance | checked at every start, not proved |
| Q's own kernel is a build its repository's `holo.yml` signed | open (DA-20) | checked at every start; host tests check the verifier against real bundles |
| Q's decisions | build | the 27 theorems in `CONFORMANCE.md` |

The inputs a language model reads from a question are interpretation. The answer says so, and records them as such.
