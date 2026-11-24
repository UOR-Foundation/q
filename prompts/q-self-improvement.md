# Prompt: make Q improve itself with every interaction, verifiably

You are working on Q, the UOR Foundation's AI agent on Discord: repository UOR-Foundation/q, deployed on the Foundation's VPS. Read `AGENTS.md`, `ARCHITECTURE.md`, `docs/improve.md`, `docs/chaos.md` and `docs/context.md` before anything else.

## The goal

Explore and build the most ingenious way for Q to get better with every interaction, as automatically as possible, using three things it already has:

- **BLAKE3 content addressing** (`uor-addr` kappa labels). Every record Q keeps is named by the hash of its content.
- **LexLean**. Every decision Q makes is a total function, and Lean's kernel proves its theorems.
- **Its members' interactions**: questions, replies, reactions, `/feedback`, and what members say after Q answers.

Q must know itself completely and verifiably, and evolve from what it learns.

## First, define "self-aware" so it can be built and checked

Do not claim consciousness. Self-awareness here means one thing: Q holds a complete, current, verifiable model of itself, and acts on it. Define its parts and keep each one exact:

1. **Identity.** Its kernel holo, model, signed commit, theorems and vectors; the community holo and commit; its genome; its prompt's label.
2. **Knowledge.** What it has indexed, per source, channel and age, and what it has forgotten and why.
3. **Competence.** For every question class: how often it answers, refuses, is approved, is corrected, and how fast. Measured, not guessed.
4. **Limits.** Its open gaps, its disproved chaos experiments, its regressions, and what its rules forbid it to do.
5. **History.** How each of the above changed, as a chain of records linked by BLAKE3 label that no one can rewrite.

Q must be able to answer "what are you, what do you know, what can't you do, how have you changed" from these records alone. Anyone must be able to recompute every claim from the records and the holo.

## What exists, so you build on it rather than beside it

- **Kernel** (`app/src/Policy.lex.tex`, `Contract.lex.tex`). There are 25 decisions over 8-byte requests, with 41 theorems and 188 vectors. The relevant ones:
  - 19 and 20: chaos experiments and steady state.
  - 21: a gap is filled.
  - 22: an answer becomes a test.
  - 23: the evaluation gate.
  - 24: promote a genome (`neverPromoteWorse`).
  - 25: file a request (`fileOnlyConsented`).
- **Loop** (`host/src/improve.ts`): gaps and fills, tests, the daily evaluation, genome evolution and the hash-chained review, read with `/improve`. It also handles `/feedback`, filed to UOR-Foundation/community once enough members support a request.
- **Chaos** (`host/src/chaos.ts`): experiments run through a shadow pipeline, approved by the community by label.
- **Records**: every turn leaves a context record, an answer record and a CloudEvent. Answers are memoized by a BLAKE3 key over everything they depend on.

## Constraints that are not negotiable

- **No self-modification of rules or code.** Q never edits its own LexLean, its host code or its prompts in production and adopts the result unreviewed. A change to the kernel reaches Q only as a build its own `holo.yml` signed, which the kernel checks at every start. Q may generate a proposed change, prove it, test it and open it for review; it may not merge it.
- **Automatic means kernel-gated, measured, recorded and reversible.** Anything Q changes about itself without a human must be:
  1. decided by a proved kernel decision;
  2. measured on the same questions as the thing it replaces, in the shadow pipeline;
  3. kept as a BLAKE3-labelled record that names its parent and its evidence;
  4. undone by adopting the parent.
- **No policy `if` in host code.** Every new judgment is a decision with theorems, vectors, a row in `model/ids.toml` and a `@rejects` scenario. Plant a defect for each theorem and show Lean refuses it.
- **Privacy.**
  - A member's words never leave Discord without their consent (DA-22, DA-30).
  - Forgetting a member (`/forget-me`) removes everything derived from them, including tests, gaps, feedback and anything learned from their words.
  - Restricted channels are never read.
  - Retention stays at 180 days.
- **The blast radius is minimized.** Every experiment or evaluation yields to real questions (decisions 19 and 23).
- **Governance.** Follow `AGENTS.md` and the Qortara routing. Never claim owner approval. Changes to the community repository go through its human gates.

## Directions to explore, then pick and build the best

Rank these by how much each one improves Q per interaction, against what it costs and risks. Build the top ones fully. Write down why you rejected the others.

1. **Every interaction is a labelled signal.** Turn each reply, reaction, correction ("that's wrong, it's X"), follow-up question and silence after an answer into a typed, consented signal record linked to the answer it judges. Define the signal taxonomy and which decision admits each kind.
2. **Corrections become knowledge, not just tests.** When a member corrects Q, the correction is the gold answer. Should it be indexed, searched by the question, and preferred over the source Q cited, under a proved rule about trust levels? Consider decision 8 and how a correction's trust is established.
3. **The prompt as a genome.** Treat Q's SYSTEM prompt and answer style as evolvable, like the retrieval settings: mutations drawn from BLAKE3, measured on tests and refusal probes, and promoted only by decision 24. The prompt's label is already part of the answer key.
4. **Self-generated tests.** From gaps, corrections and chaos findings, Q drafts new test cases and new refusal probes. Which ones can be admitted automatically, and which need a member's approval?
5. **Competence by question class.** Cluster questions by BLAKE3 label and embedding. Track answer quality per cluster, then route weak clusters to new sources or gap-filling requests.
6. **Self-proposed kernel changes.** Q writes the proposed LexLean, theorem and vectors for a new decision (for example, from a recurring correction pattern), runs `npx prism-code check` and `build` in a sandbox, and opens a pull request with the proof. It never merges.
7. **Prism-native skills.** A skill is a small Prism app in LexLean, built with `npx prism-code init` and `build`, named by the BLAKE3 hash of its holo, and admitted only if it verifies and all its vectors replay. Q calls it as a tool. Should Q be able to draft new skills from requests and gaps, and how is a skill marked unreviewed until a person checks it?
8. **Self-knowledge on demand.** "Who are you" and "how have you changed" are answered from the review chain with citations to the records, as the basis for Q's introduction.

## What to deliver

1. A design note (`docs/self-improvement.md`): the self-model's fields, the signal taxonomy, the chosen directions with their decisions, and what stays human.
2. The kernel decisions, theorems and vectors, with planted-defect evidence.
3. The host code, with tests for every path, including forgetting and the privacy rules.
4. JSON schemas for every new record and event in `docs/schemas`.
5. A measurement plan: what "better with every interaction" means in numbers, where Q reports it, and the first week's baseline.
6. Deployed on the VPS through the signed build, verified live in the test server only.

## How you will be judged

- A skeptical reviewer can recompute every self-claim Q makes from its records and its holo.
- Q measurably improves on its own tests and probes over a week, with no regression on refusals, with every change traceable to the interaction that caused it.
- Nothing Q did to itself bypassed the kernel, the signed build, or a member's consent.
