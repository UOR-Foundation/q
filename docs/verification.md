# Verification record

Project-owned evidence for the gates in `VERIFICATION.md`. Run with prism-code 0.11.2 on 2026-11-24. Build with the version host/package.json pins: the host's runtime must read the holo the build writes.

## Result

| Command | Result |
| --- | --- |
| `npx prism-code@0.11.2 check --json` | exit 0; 42 of 42 theorems proved; 31 IDs, 31 scenarios, 1 authority, 1 claim; no contract violation |
| `npx prism-code@0.11.2 build --json` | exit 0; 192 of 192 acceptance vectors replayed |
| `npx prism-code@0.11.2 verify --json` | exit 0; identities verified; 192 of 192 vectors on fresh instances |
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

After restoring, `build` and `verify` passed again with the figures above.

## Host

| Command | Result |
| --- | --- |
| `npm run typecheck` in `host/` | exit 0 |
| `npm test` in `host/` | 74 of 74 tests pass, against the real holo with an in-process store, embedder, language model and community |

## Not covered

- The link from request bytes to a decision function is tested by vectors, not proved.
- The host has run live on 2026-11-24 against Discord, an OpenAI-compatible language model and llama.cpp embeddings, from its Docker image (see `host/README.md`). It has not run against a Kappa Registry, and that run is observation, not a test.
- `qortara` is not installed on this machine, so its repository checks were not run.
- The website's adapter is tested over HTTP in process, with the test model. It has run on one machine against the production language model (`docs/web.md`, Measured); it has not run behind a reverse proxy.
