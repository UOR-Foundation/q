# Q on the website

Q answers on uor.foundation through `host/src/adapter/web.ts`. It is the same pipeline as on Discord, on a third surface, `web`.

## Why

The language model takes seconds and its key cannot leave the server. Everything else Q does is public and takes under a millisecond. So the model should run once per question, and the rest should run where the visitor is: the browser runs the same signed kernel, names each question by a label it computes itself, and checks what it is sent.

## What is never served

On any surface but Discord the kernel withholds every item in the private namespace: decision 17, proved for every surface as `Policy.privateNeverLeavesDiscord` (DA-31). Retrieval on the website searches only the namespaces the kernel serves there, and each hit is still decided one by one.

A turn on the website leaves the same private context record, answer record and event as any turn. None of them, and no label of them, is sent to the browser.

## Three labels

| Label | Of what | Who computes it |
| --- | --- | --- |
| Manifest | [`uor-agent/web-manifest/1`](schemas/web-manifest.schema.json): the kernel, the community pin, the index the website is served (one label over its sorted chunk labels), the prompts, the model, the retrieval settings | the host; the browser recomputes it |
| Question key | `{type: "web-question", question: <normalized>, manifest: <manifest label>}` | the browser, alone |
| Answer | [`uor-agent/web-answer/1`](schemas/web-answer.schema.json): the text, the claim level, the sources, the decision | the host; the browser recomputes it |

A question is normalized as NFC, lower case, runs of white space as one space, trimmed. All three are BLAKE3 kappa labels by `@uor-foundation/uor-addr`.

On the website an answer has no conversation history, so the same question key is the same computation. That holds for an answer that called no tool; one that did is never remembered. A change to anything in the manifest gives every question a new key, and the old keys are forgotten.

## Routes

| Route | Answers |
| --- | --- |
| `GET /manifest` | the manifest and its label, the suggested questions with their keys, and the answer to each one already computed |
| `GET /answer/<question key>` | the answer computed for that key, or 404. No retrieval, no model, no question text, no new record |
| `GET /item/<label>` | one public source as stored, so its label can be recomputed |
| `GET /kernel/<label>` | the kernel this host runs, as bytes, when that is its label: the same decisions can then run in the browser |
| `POST /ask` with `{"question": "..."}` | one turn, as server-sent events |

A read by key still asks the kernel about every source the answer cites (decisions 10 and 17). If one is no longer cited or served, the answer is no longer known and the question is asked again.

Events of `POST /ask`, in order:

| Event | When | Holds |
| --- | --- | --- |
| `queued` | at once | how many questions are ahead |
| `decided` | the kernel let the turn through (12, 13, 4, 5) | nothing |
| `sources` | after retrieval, citation (10), exposure (17) and grounding (6) | the grounding outcome and the sources, most trusted first |
| `text` | as the model writes | the next words |
| `answer` | the turn is recorded | the answer record, its label, and stage timings |
| `refused` | instead of the three above, when the kernel stopped the turn | the decision, such as `rate limited` |
| `failed` | on an error | a plain sentence |

Words are held back while they could still be taken back: the one word a model says when the sources do not answer, a plain answer discarded for one that states a community decision, and any answer when the outgoing filter has a term it could mask. In those cases the visitor sees the answer whole.

Send the question as `text/plain`: that is a simple request, so a browser sends no preflight before it.

## Who is asking

A visitor is a salted hash of an address, kept in memory for the rate limit (decision 5) and for one question at a time. The salt is made at start and never written, so the hash names nobody once the process ends. A request from a page on any origin not in `WEB_ORIGINS` is refused.

`WEB_CONCURRENCY` (default 1) is how many website questions are worked on at once, so Discord keeps a model slot. Past eight waiting, a visitor is told Q is busy.

## What a browser can check, and what it cannot

It can check that the kernel it runs has the label the manifest names; that the manifest, the question key and the answer have the labels it was given; that each source is one the kernel serves on the website; that the claim level is what the kernel combines from the sources' levels; and that the grounding outcome is what the kernel answers for the band and the number of sources.

It cannot check that the model's sentences follow from the sources, or that the band is what retrieval measured. Those stay open.

## Run it

```bash
WEB_PORT=8787 WEB_ORIGINS=http://localhost:8080 node --no-warnings --env-file-if-exists=.env src/main.ts web
```

`web` serves the website alone. Without it, `npm start` serves Discord, and the website too when `WEB_PORT` is set. Bind to this machine (`WEB_HOST`, default 127.0.0.1) and let a reverse proxy carry TLS; set `WEB_TRUST_PROXY=true` behind one.

To preview on one machine, with the kernel as built here and local embeddings, `host/deploy/preview.sh` sets all of that: `preview.sh ingest` once, then `preview.sh web`. Its header gives the one `docker run` for the embeddings server. Point the website at it with `VITE_Q_API=http://localhost:8787` in `.env.development.local` and run its dev server on port 8080.

## Measured

On one machine on 2026-11-24: this host in web mode, local llama.cpp embeddings (nomic-embed-text-v1.5, twelve threads), 612 public chunks, and the production language model (Qwen3.8-27B on Featherless). Times are from the request to the first event of each kind, as a client on the same machine saw them. A network round trip comes on top of each.

| Question | decided | sources | first word | answer |
| --- | --- | --- | --- | --- |
| What is a holo? (first after start) | 42 ms | 520 ms | 3.2 s | 10.6 s |
| What is LexLean and how does it relate to Lean? | 34 ms | 129 ms | 2.6 s | 13.5 s |
| How do I start a new Prism app? | 37 ms | 104 ms | 2.0 s | 13.6 s |
| What will the price of Bitcoin be in December 2027? | 49 ms | 173 ms | none | 186 ms, not grounded |

An answer read back by its question key took 9 to 17 ms on the host. Four questions are a sample, not a distribution. The first embedding after start took 421 ms; later ones 42 to 84 ms. The production host gives its embeddings server two threads, so its retrieval will be slower than here.
