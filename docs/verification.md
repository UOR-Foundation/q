# Verification record

Project-owned evidence for the gates in `VERIFICATION.md`. Run with prism-code 0.11.2 on 2026-11-24. Build with the version host/package.json pins: the host's runtime must read the holo the build writes.

## Result

| Command | Result |
| --- | --- |
| `npx prism-code@0.11.2 check --json` | exit 0; 29 of 29 theorems proved; 23 IDs, 23 scenarios, 1 authority, 1 claim; no contract violation |
| `npx prism-code@0.11.2 build --json` | exit 0; 136 of 136 acceptance vectors replayed |
| `npx prism-code@0.11.2 verify --json` | exit 0; identities verified; 136 of 136 vectors on fresh instances |
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
| The dispatcher answers `denied` where the register says `not authorized` | `build` | `build.vectors`: 2 of 80 vectors are not what the model answers; no holo written |

After restoring, `build` and `verify` passed again with the figures above.

## Host

| Command | Result |
| --- | --- |
| `npm run typecheck` in `host/` | exit 0 |
| `npm test` in `host/` | 48 of 48 tests pass, against the real holo with an in-process store, embedder, language model and community |

## Not covered

- The link from request bytes to a decision function is tested by vectors, not proved.
- The host has run live on 2026-11-24 against Discord, an OpenAI-compatible language model and llama.cpp embeddings, from its Docker image (see `host/README.md`). It has not run against a Kappa Registry, and that run is observation, not a test.
- `qortara` is not installed on this machine, so its repository checks were not run.
