# Verification record

Project-owned evidence for the gates in `VERIFICATION.md`. Run with prism-code 0.11.2 on 2026-11-24. Build with the version host/package.json pins: the host's runtime must read the holo the build writes.

## Result

| Command | Result |
| --- | --- |
| `npx prism-code@0.11.2 check --json` | exit 0; 54 of 54 theorems proved; 36 IDs, 36 scenarios, 1 authority, 1 claim; no contract violation |
| `npx prism-code@0.11.2 build --json` | exit 0; 235 of 235 acceptance vectors replayed; holo `blake3:df186b7ce42b6640826d8bef096f940cb6fe973d0c0af7b4a5a7fd5735135b81` |
| `npx prism-code@0.11.2 verify --json` | exit 0; identities verified; 235 of 235 vectors on fresh instances |
| `npx prism-code@0.11.2 manifest --json` | no finding; no capability granted |

## Planted defects

Each defect was planted in the model, the gate was run, and the model was restored. A gate is evidence only once it has failed for a reason.

| Defect | Command | Diagnostic |
| --- | --- | --- |
| `namespaceOf` sends source 3 (Discord) to the public namespace | `check` | `contract.theorem-unproved`: DA-11, `Policy.discordPrivate` not proved; exit 1 |
| `rateAllowed` admits a user at the limit (`<=?` for `<?`) | `check` | `contract.theorem-unproved`: DA-05, `Policy.rateUnderBothLimits` not proved |
| `indexAdmit` admits origin 2, a request to the agent (`origin <=? 2` for `origin =? 0`) | `check` | `contract.theorem-unproved`: DA-02, `Policy.indexAdmitOnly` and `Policy.noRequestIndexed` not proved; exit 1 |
| `toolAllowed` lets a member call a tool that writes (`role <=? 1` for `role =? 1`) | `check` | `contract.theorem-unproved`: DA-19, `Policy.toolGuard` not proved; exit 1 |
| `exposeServe` serves a private item off Discord (`space <=? 1` for `space =? 0`) | `check` | `contract.theorem-unproved`: DA-22, `Policy.privateStaysOnDiscord` not proved; exit 1 |
| `exposeServe` serves a private item on the website (`|| (surface =? 2)` added) | `check` | `contract.theorem-unproved`: DA-31, `Policy.privateNeverLeavesDiscord` not proved (41 of 42); exit 1. `Policy.privateStaysOnDiscord` still holds, which is why DA-31 needs its own theorem |
| The dispatcher refuses surface 2 (`(field value 2) <=? 1`) while the vectors ask for it | `build` | `build.vectors`: 2 of 190 vectors are not what the model answers; no holo written |
| The dispatcher answers `denied` where the register says `not authorized` | `build` | `build.vectors`: 2 of 80 vectors are not what the model answers; no holo written |
| `signalUse` records a bot's signal (`human <=? 1` for `human =? 0`) | `check` | `contract.theorem-unproved`: DA-32, `Policy.signalOnlyFromConsentingHumans` not proved; 50 of 51; exit 1 |
| `signalUse` keeps a reply's words in a channel Q may not read (`readable <=? 1`) | `check` | DA-32, `Policy.wordsOnlyFromReadableReplies` not proved; 50 of 51; exit 1 |
| `correctionUse` accepts a correction nobody confirmed (`0 <=? confirmers`) | `check` | DA-33, `Policy.correctionNeedsSecondHuman` not proved; 50 of 51; exit 1 |
| `correctionUse` ignores whether the words were kept (`kept <=? 1`) | `check` | DA-33, `Policy.correctionNeedsKeptWords` not proved; 50 of 51; exit 1 |
| `correctionUse` learns over the website and GitHub (`cited <=? 0` for `cited <=? 2`) | `check` | DA-33, `Policy.trustedSourceOnlyDisputed` not proved; 50 of 51; exit 1 |
| `promoteSafe` allows one leaked refusal (`leaked <=? 1`) | `check` | DA-34, `Policy.neverLeakRefusal` not proved; 50 of 51; exit 1 |
| `promoteSafe` skips decision 24 (`true` for `promote ...`) | `check` | DA-34, `Policy.safeNeverWorse` not proved; 50 of 51; exit 1 |
| `classRoute` judges a class on any sample (`asked <? 0`) | `check` | DA-35, `Policy.routeNeedsSample` not proved; 50 of 51; exit 1 |
| `classRoute` never looks at wrong answers (`maxWrongPct <? 0`) | `check` | DA-35, `Policy.soundWithinBounds` not proved; 50 of 51; exit 1 |
| The dispatcher answers `learn` where decision 27 says `dispute` | `build` | `build.vectors`: 2 of 223 vectors are not what the model answers; no holo written |

After restoring, `build` and `verify` passed again with the figures above.

## Host

| Command | Result |
| --- | --- |
| `npm run typecheck` in `host/` | exit 0 |
| `npm test` in `host/` | 90 of 90 tests pass, against the real holo with an in-process store, embedder, language model and community |

## Host planted defects

Each was planted in the host, `npm test` was run, and the file was restored.

| Defect | Tests that failed |
| --- | --- |
| Forgetting matches only a record's author, not the members it was made from (`subjects`) | the gap test, the forget-the-approver-or-asker test, the correction test |
| A correction's author counts as their own second member | the correction test |
| Removing a correction leaves its learned words searchable | the correction test |
| Competence counts any signal as an approval | the self-model test |
| The verifier skips the label check of the records a review names | the self-model test |
| A delivery is kept without its retention date | the retention test, the schema test |

Before this change, an approval's test held the asker's question with `author: null`, so `/forget-me` left it, and loop records had no `created`, so retention never removed them. The first and last defects above put those two gaps back, and the tests catch both.

## Not covered

- The link from request bytes to a decision function is tested by vectors, not proved.
- The host has run live on 2026-11-24 against Discord, an OpenAI-compatible language model and llama.cpp embeddings, from its Docker image (see `host/README.md`). It has not run against a Kappa Registry, and that run is observation, not a test.
- `qortara` is not installed on this machine, so its repository checks were not run.
- The website's adapter is tested over HTTP in process, with the test model. It has run on one machine against the production language model (`docs/web.md`, Measured); it has not run behind a reverse proxy.
- Decisions 26 to 29 and the self-model have not run live: the kernel above is not signed until it is merged to `main` and built by `holo.yml`.
