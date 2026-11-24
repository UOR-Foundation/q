# Apps from one prompt

A member types `/build` and describes what an app should decide. Q replies with a link to that app, running in its own holospace, verified, with its proofs. It usually takes under a minute.

## Why

The UOR Foundation's promise is software whose behaviour is proved, not claimed. The quickest way to feel that is to ask for an app and use it a minute later. Every answer the app gives is computed by a model that Lean's kernel proved, in the person's own browser.

## How

1. **Design.** Q's language model turns the request into a small decision table (`host/src/apps.ts`): a few fields the person types, the outcomes, and first-match rules. A table the generator refuses goes back to the model once, with the reason.
2. **Check.** The generator (`host/src/appgen.ts`) refuses any table that would not make a sound app, and says why.
3. **Generate.** The table becomes a complete app in prism-code's own template:
   - a LexLean model that parses the typed words;
   - one theorem that every answer is a declared outcome, and one per rule that it decides its outcome whenever it is the first to match;
   - an acceptance vector for every combination of inputs (up to 128), plus malformed requests;
   - its claim ledger and scenarios.
4. **Prove, build, verify.** `prism-code build` proves every theorem and replays every vector; `prism-code verify` judges what was built. This runs in the builder service (`host/src/builder-service.ts`), a separate process with its own memory and CPU, one build at a time, so a build can never starve Q.
5. **Publish.** The holo goes to Filebase, an IPFS pinning service (`host/src/filebase.ts`). Its link is `space.html#app=<BLAKE3 label>&holo=<gateway URL>`. The holospace page fetches the bytes, checks them against the app's BLAKE3 label, verifies them, and runs the app in a sandbox. The gateway is trusted for availability only.

While a build runs, Q edits its reply at each stage: designing, writing the model, proving, verifying, publishing.

## What

- `/build` is open to every member (command 8 of decision 4), at most 3 apps an hour per person and 10 per channel (decision 5).
- Apps are decision tables over typed words: 1 to 4 fields, 2 to 8 values each, 2 to 12 outcomes, up to 24 rules. A request that needs free text, arithmetic, memory or the network becomes the closest useful table, and its purpose says what it decides.
- The builder needs `FILEBASE_ACCESS_KEY`, `FILEBASE_SECRET`, `FILEBASE_BUCKET` and optionally `FILEBASE_GATEWAY`. Q needs `BUILDER_URL`.
- Richer apps wait on the community's builder ([afflom/prism-devrel](https://github.com/afflom/prism-devrel)): it already turns DMN tables, XACML policies and UML state machines into apps, but targets an older SDK ([afflom/prism-devrel#27](https://github.com/afflom/prism-devrel/issues/27)).
