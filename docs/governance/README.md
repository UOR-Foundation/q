# Q default-branch enforcement proposal

**State:** PROPOSED ONLY. This is a disabled GitHub repository-ruleset request and a deployment/verification checklist, **not evidence that any setting exists**. It neither appoints a maintainer nor approves a security exception. See [governance issue #6](https://github.com/UOR-Foundation/q/issues/6), [draft CODEOWNERS PR #2](https://github.com/UOR-Foundation/q/pull/2), and [Foundation tracker #19](https://github.com/UOR-Foundation/.github/issues/19).

## Observed before state

On 2026-11-24, `main` at `0aaa4b45128a86f749f38121ec0d1819590f19a5` reported `protected: false`, no enforced required contexts, and no effective repository/parent rulesets via `GET /repos/UOR-Foundation/q/rulesets?includes_parents=true`. The classic branch protection endpoint returned 403 to this integration: that is **not** proof of settings absence. Q's existing `.github/workflows/ci.yml` has a `verify` job on PRs and `push.main`, covering Prism check/build/verify, locked host install, generated bindings parity, typecheck and host tests. GitHub's check-run record on the last main commit identifies `verify` as GitHub Actions app **15368**. Do not substitute the signed-holo publication job for `verify`.

## Proposed minimum (repository-specific Tier 2)

Payload: [disabled creation request](q-main-ruleset.json). Apply to `refs/heads/main` only; no broad bypass actors. Reject direct pushes, deletion and non-fast-forward changes; require a pull request and the exact `verify` context **from app 15368** with strict up-to-date base checks. Proposed approval count is **0 only as the current Foundation baseline**, pending authenticated owner decision. This is not approval of zero reviews as good long-term security practice. A formally accepted owner may choose a stricter approval requirement, but must first establish who has independent review authority and ensure a practical non-self-review path.

**Important:** Existing users `@afflom` and `@humuhumu33` currently have `admin` collaborator permissions. Those permissions and authored commits do not establish formal appointments. Q's `GOVERNANCE.md` still says owner, review, amendment, and exception authority `NOT_ESTABLISHED`; `SECURITY.md` still lacks verified private reporting. This file does not resolve either. Require explicit owner acceptance of the settings and owner identities before activation.

## Owner-only installation and verification

1. Authenticated organization/repository owner accepts or corrects this proposal and records the review and escalation decision in `GOVERNANCE.md`. Identify the people/teams with authority and ensure a qualified substitute path when a reviewer is unavailable.
2. Compare live `main`, current effective rule stack, and current check-run app/source with the evidence above; stop if they drift. Confirm the repository has the GitHub plan/permissions needed for these rules.
3. With authorized repository administration access, create the candidate ruleset in **disabled** mode through GitHub Settings → Rules → Rulesets or the [repository rulesets API](https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset). The JSON is an API-shaped request, **not a verified GitHub UI import format**. Read back its id, target, status, conditions, all rule parameters and bypass actors; no assumptions about UI serialization.
4. Before activation, confirm Q's existing `ci / verify` reports on PR heads, uses GitHub Actions app 15368, and passes on the current base; confirm `.github/workflows/holo.yml` still performs signed-holo publication on successful `main` pushes (no special bypass needed). Do not make `publish the holo` a PR-required check.
5. Obtain separate authenticated authorization to activate. Read back **effective** settings from GitHub, not this file. Verify strict `verify` context, PR requirement, delete and force-push protections, actual bypass list, review count and protected branch.
6. Run one qualified passing PR and representative **negative checks** using disposable branches and no live-secret exposure: failing `verify`, missing `verify`, stale or wrong-app `verify`, direct update to `main`, non-fast-forward push and branch deletion must be blocked. A check labelled `verify` from an untrusted app must not pass. If a negative is unexpectedly accepted, document that and **do not declare protected**; remediate the ruleset. Never attempt destructive tests against `main` outside a controlled authorization/test plan.
7. Confirm the downstream signed holo is published normally after a qualified merge; log actual checks, run IDs, settings snapshot, owner decision and before/after impact in issue #6 and Foundation tracker #19. CI minutes and financial ROI: `NOT_MEASURED` until recorded.

## Separate pending policies

- The [draft CODEOWNERS proposal](https://github.com/UOR-Foundation/q/pull/2) cannot be counted until accepted, merged and verified at `main/.github/CODEOWNERS`.
- Appoint owner/maintainers with authenticated evidence and scoped duties. Keep accepted contributors distinct from appointed maintainers; privately confirm Discord IDs before roles.
- Establish and verify a private vulnerability intake channel, response/triage owner and supported-version policy before replacing `SECURITY.md` placeholders.
- If Foundation Tier 0 is installed later, independently verify that stronger repo-specific Tier 2 gates continue to apply; an organization safety floor is not a substitute.

## Completion status

This source artifact contributes **zero** effective branch protections. Local API deployment, negative tests and owner acceptance are **NOT_RUN**. No governance coverage increment or ROI is claimed.
