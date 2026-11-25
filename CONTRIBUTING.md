# Contributing

Read [AGENTS.md](AGENTS.md) first. Its six rules, R1 to R6, apply to every change.

## Architecture and governance before any change

Read [ARCHITECTURE_INDEX.md](ARCHITECTURE_INDEX.md), [GOVERNANCE.md](GOVERNANCE.md) and [SECURITY.md](SECURITY.md). Identify the affected claim owners and dependent contracts in the canonical register. Keep registration and affected design documentation current in the same PR. Record the revision, affected area IDs, owner decisions where required, and actual gate evidence. Do not treat a structural test as owner approval.

Run `cd host && node --test test/architecture-index.test.ts` in a Git checkout before handing off changes; native CI also runs it with the host suite. Follow the Qortara lifecycle requirements in AGENTS.md. If native Qortara checks are unavailable or an instruction lock conflicts, disclose the gap and escalate; do not claim they passed.

## Changing what the agent decides

A decision lives in the model, never in the host.

1. Add or change the row in `model/ids.toml`, then its scenario in `features/suites/`.
2. Change the model in `app/src/`: the definition, the theorem the row names, and an acceptance vector for each accepted path and each refusal.
3. Run `npx prism-code@0.11.2 check --json` until it exits 0, then `build` and `verify`.
4. Plant a defect that the new theorem or vector should catch, confirm it is refused, and record it in `docs/verification.md`.
5. In `host/`, run `npm run generate`, then add the question to `src/kernel.ts`.

Never weaken a gate to pass it, and never edit `CONFORMANCE.md` or `host/src/client/` by hand.

## Changing what the agent does

Effects live in `host/`. If a change needs an `if` about policy, it belongs in the model instead.

```bash
cd host
npm ci
npm run typecheck
npm test
```

## Commits and branches

Conventional Commits 1.0.0: `type(scope): description`. Branches are `{type}/{issue#}-{short-description}`. Changes land by pull request.

## Conduct and security

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) and [SECURITY.md](SECURITY.md).
