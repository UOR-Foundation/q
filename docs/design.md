# Design note

## The one decision

A Prism application is pure: no network, clock or storage. A Discord agent is almost all effect. So the agent is split in two, and the split is the design.

- The **kernel** decides. It is a LexLean model, proved by Lean's kernel, packaged as a holo.
- The **host** acts. It asks the kernel before each effect and obeys.

The alternative was an ordinary bot with policy in code and a Prism app beside it for show. That gives no guarantee about what the bot does. Here the guarantees are small but real: the bot cannot index an opted-out author or send an uncited answer without the kernel saying so, and the kernel provably never says so.

## What the guarantees cover, and where they stop

Proved: properties of the decision functions (see `CONFORMANCE.md`).

Tested: the byte-level dispatcher (82 vectors), and the host's use of the kernel (19 tests).

Trusted, not checked: the facts the host passes in. The kernel proves "an unverified item is never cited"; it cannot prove the host verified honestly. Two inputs are operator settings rather than decisions: the similarity thresholds that make a score band, and the claim level each source declares. Channel labels are no longer one: they come from the community repository, at the commit its signed holo was built from (docs/context.md).

## Content addressing

Every stored item is a JSON record named by its kappa label, `blake3:<64 hex>`, computed by `@uor-foundation/uor-addr`. The store keeps items by label and typed edges between labels, using the Kappa Registry's relation names. The search index is derived from the store and can be rebuilt.

What this buys: identical content is stored and embedded once; an unchanged chunk is skipped on re-index; a citation can be checked by fetching the item and recomputing its label; an answer is a record naming exactly its evidence and the kernel model that judged it.

What it costs: `uor-addr` addresses JSON, not raw bytes, so a document is stored as a record holding its text. Embedding vectors are floats and are kept only in the index, so rebuilding the index means embedding again.

## Privacy, and its conflict with content addressing

A content address is permanent. A person's message should not be.

- Discord content and answers go to a private namespace, never the public one. This is a proved kernel guarantee (DA-11).
- Only channels labeled public are indexed, following the community read policy. Unlabeled means not indexed.
- `/forget-me` deletes the author's messages and the answers to their questions, writes a revocation for each, and opts the author out from then on. Only the label survives, and a label reveals nothing without the content.
- The opt-out is itself a stored record holding the author's id. It has to be: that is how the agent knows not to index them again.
- Items older than `RETENTION_DAYS` are deleted by a daily sweep.
- Logs carry decisions and counts, never content or author.

If the store of record cannot delete an item, Discord content must stay out of it. The folder store can. Whether the Kappa Registry can is unverified.

## Cost

Per question: one embedding of the question, and one language-model call with up to six chunks of at most 1,200 characters, roughly 2,500 input tokens and a few hundred output tokens. A refused question costs one embedding and no model call. Ingesting the community model and the website is about 600 chunks, embedded once. With a local model through Ollama for both, the running cost is the machine.

These are estimates from chunk sizes, not measurements.

## Continuous indexing

Every message is offered to the kernel as it arrives; the kernel admits or skips it. History is read once by `npm run backfill`, which records its place after each page so it can resume. discord.js waits out rate limits. Edits and deletions of a message on Discord are not yet followed: a deleted Discord message stays indexed until retention or a forget command removes it.

## What was left out

Compared with LangBot: no web panel, plugin marketplace, sandbox, voice, or second platform. Administration is slash commands and environment variables. Adding a platform is a new adapter file; the model does not change.

Not built: an MCP client. A tool call is an effect, and no kernel decision yet says which tools may be called, so adding it means a new conformance ID first.

## Known limits

- Counts, ages and limits are one byte in a kernel request: rate limits to 255, retention to 254 days.
- Forgetting and retention scan every private item. That is fine for one community server and will need an index on author and channel beyond it.
- The holo is unsigned and at assurance level P0.
- The LexLean project keeps the template's internal names, because prism-code 0.11.2 cannot rewrite the lockfile.
