# uor-discord-agent

Q, the UOR Foundation's AI agent on Discord, as a Prism application: every decision written in LexLean and proved by Lean's kernel, every effect in a host that asks first.

## Why

A community assistant answers for the community. If its rules live in code beside the model, nobody can say which rule produced an answer. Here every rule is a proved decision, every answer names the evidence and the decisions behind it, and the community's own repository is the one authority Q follows.

## How

Q has two parts, the same shape as [LangBot](https://github.com/langbot-app/LangBot) ([docs/langbot.md](docs/langbot.md) maps them):

- **Kernel** (`app/src/`). Fifteen decisions: read, index, reply, command, rate limit, grounding, claim level, source trust, retention, citation, namespace, access control, content filter, long text, tool calls. Pure: no network, clock or storage. Built with `npx prism-code@latest`.
- **Host** (`host/`). Everything with an effect: the Discord adapter, the pipeline, the language model and embeddings, retrieval, MCP tools, the store. It holds no policy. Before each effect it asks the kernel and obeys.

Q's inputs and outputs are defined in [docs/context.md](docs/context.md): Q's kernel, the community root (UOR-Foundation/community's signed holo, pinned by its BLAKE3 label and verified provenance), and the question go in. A context record, an answer record and a public event come out of every turn, each named by its BLAKE3 kappa label, each with a published schema.

## What is established

| Kind | What |
| --- | --- |
| Proved | The 25 theorems named in [CONFORMANCE.md](CONFORMANCE.md), about the decision functions in `app/src/Policy.lex.tex` and the request length in `app/src/Contract.lex.tex` |
| Tested | 115 acceptance vectors through the byte-level dispatcher; 32 host tests, including a real MCP server over the protocol and the records against their schemas |
| Measured at every start | Q's read policy against the community's `uor-discord-read`, on all 96 requests (DA-13); the community holo's signed provenance; every vector of both holos |
| Cited | The community Discord read policy, from `UOR-Foundation/community`. DA-01 reproduces it |
| Open | The facts the host passes in, the similarity thresholds, the language model's reading of a question, and what [host/README.md](host/README.md) lists as not run |

The theorems are about the decision functions. That the dispatcher decodes a request into the right call is tested by the vectors, not proved.

## What

```bash
npx prism-code@0.11.1 check --json     # the model checks and every theorem is proved
npx prism-code@0.11.1 build --json     # write app/.prism/build/uor-discord-agent.holo and replay its vectors
npx prism-code@0.11.1 verify --json    # judge what was built
```

`0.11.1` is `@latest` today, and `host/package.json` pins the same runtime: the host must read the holo the build writes. To run the agent, see [host/README.md](host/README.md).

On every push to `main`, `.github/workflows/holo.yml` builds the holo, signs its SLSA provenance and publishes it at `https://uor-foundation.github.io/uor-discord-agent/app.holo`.

## Request

Exactly eight bytes: one decision, then seven facts. Unused facts are zero. The answer is text. A request of another length, an unknown decision or a fact out of range is answered `invalid request`.

| Byte 0 | Decision | Facts (bytes 1 on) | Answers |
| --- | --- | --- | --- |
| 1 | read a channel | kind, visibility, label, install, intent | `permit`, `deny`, `not-applicable`, `indeterminate` |
| 2 | index a message | the five channel facts, origin, author opted out | `index`, `skip` |
| 3 | reply | kind, visibility, trigger | `reply`, `silent` |
| 4 | run a command | command, role | `allowed`, `not authorized` |
| 5 | rate limit | user count, user limit, channel count, channel limit | `allowed`, `rate limited` |
| 6 | grounding | score band, citations | `answer`, `answer with notice`, `not grounded` |
| 7 | answer level | level, level | `build`, `some-true`, `open` |
| 8 | prefer a source | source, source | `community`, `website`, `github`, `discord` |
| 9 | retention | class, forget, age, limit | `delete`, `keep` |
| 10 | cite an item | labelled, verified, revoked | `cite`, `drop` |
| 11 | namespace | source | `public`, `private` |
| 12 | access control | mode, listed | `continue`, `ignore` |
| 13 | content filter | stage, scope, filter result | `continue`, `masked`, `interrupt` |
| 14 | long text | size, strategy | `send`, `split`, `file` |
| 15 | tool call | server, effect, role | `call`, `refuse` |

Fact codes:

| Fact | Codes |
| --- | --- |
| kind | 0 text, 1 forum, 2 voice, 3 direct message |
| visibility | 0 everyone, 1 restricted |
| label | 0 public, 1 unlabeled, 2 excluded |
| install | 0 admin, 1 other |
| intent | 0 granted, 1 missing |
| trigger | 0 none, 1 mention, 2 reply to the agent, 3 slash command |
| origin | 0 a person's conversation, 1 a bot, 2 a request to the agent |
| command | 0 ask, 1 search, 2 status, 3 reindex, 4 forget-channel, 5 forget-me |
| role | 0 member, 1 admin |
| score band | 0 low, 1 medium, 2 high |
| level | 0 build, 1 some-true, 2 open |
| source | 0 community, 1 website, 2 GitHub, 3 Discord |
| class | 0 public source, 1 Discord |
| mode | 0 blacklist, 1 whitelist |
| stage | 0 incoming, 1 outgoing |
| scope | 0 both, 1 incoming only, 2 outgoing only |
| filter result | 0 pass, 1 warn, 2 masked, 3 block |
| size | 0 one message, 1 up to five, 2 more |
| strategy | 0 split, 1 file |
| server | 0 allowlisted, 1 not |
| effect | 0 reads, 1 writes |
| yes or no | 0 no, 1 yes |

Counts, ages and limits are one byte, 0 to 255, in units the host fixes.

## Known gaps

- The holo is at assurance level P0: its provenance is signed by the publishing workflow, but it carries no signed proof statement.
- `GOVERNANCE.md` leaves the owner, review and amendment authority `NOT_ESTABLISHED`, `SECURITY.md` names no reporting channel, and there is no `.github/CODEOWNERS`. Each needs the owner.
- The LexLean project and its entry module keep the template's names (`prism-template-contract`, `Contract`). Renaming them makes `lexlean.lock` stale, and `prism-code` 0.11.1 has no command to rewrite the lock.
- A reply (decision 3) does not require the channel to be readable. The agent may answer a mention in a public channel it is not allowed to index.

## License

MIT or Apache-2.0, at your option. See [LICENSE](LICENSE).
