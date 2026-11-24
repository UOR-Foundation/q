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
| Question key | `{type: "web-question", question: <normalized>, manifest: <manifest label>}`, with `after: [<keys>]` for a follow-up | the browser, alone |
| Answer | [`uor-agent/web-answer/1`](schemas/web-answer.schema.json): the text, the claim level, the sources, the decision | the host; the browser recomputes it |

A question is normalized as NFC, lower case, runs of white space as one space, trimmed. All three are BLAKE3 kappa labels by `@uor-foundation/uor-addr`.

The same question key is the same computation. That holds for an answer that called no tool; one that did is never remembered. A change to anything in the manifest gives every question a new key, and the old keys are forgotten.

## Conversations

A question may follow earlier answers. The browser names them by their question keys in `after`, oldest first, and sends no text of them.

Why by key: an answer with history is not a function of its question alone, so it must not be stored under the question's key. With the earlier keys inside it, the follow-up's key names the whole computation, and the same follow-up after the same answers is read back like any other answer.

- The kernel decides each key (decision 31, `Policy.threadOnlyKnown`, DA-37): an earlier answer is context only when this host still reads it back by its key, and it is among the newest three presented.
- The host counts an answer as read back when it is known under the current manifest of the same register, every source of it is still served (decisions 10 and 17), it used no tool, and it claims something: a refusal is nothing to build on.
- The writer is given the admitted answers' text from this host's own store. It is never given text from the request, and never the question asked under an earlier key, which may have been another visitor's.
- Retrieval reads the follow-up together with the first 300 characters of the newest admitted answer. "And how do I install it?" names nothing to look for alone.
- The key is the label of the question, the manifest and the admitted keys. `after` is absent when none is admitted, so a question that stands alone keeps the key it always had, and an answer with history never has it.
- The answer record lists `after` as admitted, so the browser recomputes the key from what the host used, which may be fewer keys than it presented.

## Two registers

An answer is written to be read, or to be heard. `register: "spoken"` asks for the second: two to four short sentences, the answer first, no markdown, the same grounding rules and the same numbered citations, which the page shows and a voice does not read out.

The spoken register is a second prompt, so a second manifest (`GET /manifest?register=spoken`). Its answers have their own keys, and no key of the written register changes. An earlier answer is context only for a question in the same register.

Speech itself is not the host's: recognition and synthesis run in the visitor's browser, and only the text of a new question reaches this host.

## Routes

| Route | Answers |
| --- | --- |
| `GET /manifest` | the manifest and its label, the suggested questions with their keys, and the answer to each one already computed. With `?register=spoken`, the same for the spoken register |
| `GET /answer/<question key>` | the answer computed for that key, or 404. No retrieval, no model, no question text, no new record |
| `GET /item/<label>` | one public source as stored, so its label can be recomputed |
| `GET /kernel/<label>` | the kernel this host runs, as bytes, when that is its label: the same decisions can then run in the browser |
| `POST /ask` with `{"question": "...", "register": "spoken", "after": ["<key>", ...]}` | one turn, as server-sent events. `register` and `after` are optional; `after` is at most eight keys. A body that is not this is answered 400 |

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

A page that closes the connection before the answer is whole gives the turn up. The model call is aborted, no answer is recorded or remembered under any key, and the visitor's next question does not wait for it. This is how a visitor who cuts in is heard at once.

## Other agents

An agent that is not a browser on uor.foundation needs less: one address, one request, one response.

| Route | Answers |
| --- | --- |
| `GET /` and `GET /llms.txt` | how to ask, as Markdown, with this host's own address in every example |
| `GET /ask?q=<question>` | the answer whole, as Markdown: the text, each source with its level and label, the claim level, and the address to read it again by its key. The answer record instead when `Accept` names `application/json` |
| `POST /ask` that accepts `application/json` or `text/markdown` | the same, with the question in the body instead of the URL |
| `POST /mcp` | Q's MCP server (`host/src/mcp-server.ts`) over Streamable HTTP: `ask`, `search`, `status`, `community_apps`, `community_decide` |

Why a GET: most agents that read the web can only fetch an address. An answer read that way is the same turn as any other on the `web` surface, with the same record and the same key. A turn the kernel stops answers 429 when it is the rate limit and 422 otherwise.

The MCP server keeps no session and opens no stream: each POST is one message and its response, so a client needs nothing but the address. It runs on the `mcp` surface, where the kernel withholds every private item as it does on the website. Each caller is its own author for the rate limit, and an `ask` waits in the same line as the website's questions.

A request with no `Origin` is not from a page and is served. A page on an origin outside `WEB_ORIGINS` is refused on every route, these included.

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
