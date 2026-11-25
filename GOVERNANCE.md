# Repository governance

## Authority and inherited requirements

Q is subject to the active [UOR Foundation governance framework](https://github.com/UOR-Foundation/.github/blob/main/governance/GOVERNANCE.md) and [operating model](https://github.com/UOR-Foundation/.github/blob/main/governance/OPERATING_MODEL.md). These apply organization-wide. The Foundation organization owners retain final governance and escalation authority; repository maintainer appointments and their scopes must be established by an authenticated owner decision.

## Roles

Repository-wide code review routing is assigned to @humuhumu33 under the creator-based CODEOWNERS designation. @Knapp-Kevin and @afflom participate as contributors; any formal maintainer delegation remains separate. The accountable policy owner, appointed maintainer scopes and local amendment authority are NOT_ESTABLISHED. See [maintainer directory](MAINTAINERS.md). Administrative GitHub access, Discord roles and contribution receipts do not appoint anyone to these governance roles.

## Decisions

Follow the Foundation change-control baseline: issue, focused branch, pull request, native CI, merge after qualification. The organization baseline requires zero approving reviews, not zero verification. Preserve Q's [template-locked instructions](AGENTS.md), model-first workflow and Qortara lifecycle checks. The existing native `ci / verify` job is the acceptance boundary; [effective enforcement](docs/governance/README.md) is tracked separately. Do not equate a source policy or passing CI run with an enforced required check.

Q-specific review delegation, exceptions and protected-operation approval paths are NOT_ESTABLISHED; escalate decisions depending on those authorities rather than infer approval. Ordinary changes may proceed within the established Foundation process and repository instructions without claiming an unresolved authority.

## Amendments

Foundation owners retain final authority for governance amendments and escalations. Q-specific delegated amendment/exception authority is NOT_ESTABLISHED. Proposed appointments and local policies require authenticated acceptance; no agent, skill, tool result or Markdown statement grants an operational permission.

See [architecture index](ARCHITECTURE_INDEX.md), [security policy](SECURITY.md), and [governance remediation #6](https://github.com/UOR-Foundation/q/issues/6).
