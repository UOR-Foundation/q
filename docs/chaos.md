# Chaos engineering in Q

Q experiments on itself in production to earn confidence that it withstands real failures. It follows [the Principles of Chaos Engineering](https://principlesofchaos.org/), and [UOR-Foundation/community](https://github.com/UOR-Foundation/community) coordinates the experiments.

## Why

Q depends on a language model, an embedder, the community holo and Discord. Each fails in production: a provider at its cap answers 429, a connection drops, a server restarts. Tests show Q handles the failures someone thought of. An experiment shows what Q actually does when one happens, on the real system.

## How: the five principles

| Principle | In Q | Where |
| --- | --- | --- |
| Hypothesis around steady state | Steady state is measured on Q's output only. It counts the questions whose outcome is wrong: an answer without a citation, a refusal where an answer was due, or an error. It also takes the 95th percentile latency. The kernel judges it, and a broken invariant is never steady. | decision 20, `Policy.breachNeverSteady`, `Policy.steadyWithinBounds` (DA-25) |
| Vary real-world events | Faults are injected at the network, where real ones happen. The model can be busy (429), down, slow or malformed; the embedder can be down; or a burst of questions arrives at once. A fault takes the real path, through the gate and the retries. | `host/src/chaos.ts` `faulty`, `providers.ts` `Transport` |
| Run in production | Experiments run on the production host, with the real model, embedder, index, community and kernel. They go through a shadow pipeline: its writes stay in memory, it reuses no earlier answer, and its answers go to no one. | `ShadowStore`, `shadowIndex` |
| Automate continuously | Every experiment is tried every `CHAOS_EVERY_HOURS` hours (24 by default), and each try leaves a record and an event. | `host/src/main.ts` |
| Minimize blast radius | The kernel lets an experiment run only on the shadow, never on live traffic. Before every question, it stops the experiment if a real question is waiting. The shadow's model gets its own gate, one call at a time. | decision 19, `Policy.runOnlyApproved`, `Policy.neverOnLiveTraffic`, `Policy.abortWins` (DA-24) |

One try goes like this:

1. **Gate.** The kernel asks two things: did the community approve this exact experiment, and is a real question waiting?
2. **Control arm.** The questions are asked with no fault. If Q is not steady without the fault, the experiment holds: a fault would prove nothing about a system that is already disturbed.
3. **Experimental arm.** The same questions are asked with the fault.
4. **Verdict.**
   - *confirmed*: the steady state held under the fault.
   - *disproved*: it did not. That is a weakness found, and it becomes the next fix.
   - *held*: the experiment didn't run, because it wasn't approved or the control wasn't steady.
   - *aborted*: a real question needed Q.

## What: BLAKE3 throughout

- **An experiment is a record**, `uor-q/experiment/1` in `experiments/`. Its BLAKE3 kappa label is its identity ([schema](schemas/experiment.schema.json)).
- **The community approves that exact label** in `automation/chaos-approvals.json`, which Q reads at the community commit it pins and verifies. Change one byte of an experiment and it becomes a new experiment that nobody has approved. No file, or no entry, means the experiment holds.
- **Which calls fail is drawn from BLAKE3** of the experiment's label and the call's index. A try can therefore be replayed fault for fault.
- **The result is a record**, `uor-q/experiment-result/1`, in the public namespace ([schema](schemas/experiment-result.schema.json)). It holds counts and durations only, never a question or an answer. It is linked `derived-from` the experiment and `certified-by` the kernel holo and the community holo that decided it.
- **Its event**, `org.uorfoundation.q.experiment`, carries the result's label as its id ([schema](schemas/experiment-event.schema.json)).

## Coordination with the community

The community repository already governs automation by exact approval: `automation/intervention-approvals.json` approves interventions by id, and it changes only in a pull request a human approved. Chaos experiments follow the same gate:

```json
{
  "spec": "uor-community/chaos-approvals/1",
  "about": "Approvals of exact chaos experiments for Q, by their BLAKE3 kappa label. Changes only in a pull request a human approved.",
  "approvals": [
    { "experiment": "blake3:…", "name": "model-busy", "approvedBy": "…", "thread": "…" }
  ]
}
```

At every start, Q logs each experiment with its label and whether it is approved. To approve one, copy its label into that file in a reviewed pull request. To withdraw it, remove the entry; Q stops running it at its next start.

## The experiments

| Experiment | Real-world event | Fault |
| --- | --- | --- |
| `model-busy` | The model provider is at its concurrency cap | 30% of model calls answer 429 |
| `model-down` | The connection to the model drops | 20% of model calls fail at the network |
| `model-slow` | The provider is congested | 20% of model calls arrive 20 s late |
| `model-malformed` | A proxy cuts the response | 20% of model calls return a truncated body |
| `embedder-down` | The embeddings server restarts | 30% of embedding calls answer 503 |
| `burst` | Many members ask at once | three copies of every question at the same moment |

Each asks six questions: three that should be answered with citations, two that should be refused, and one empty question. Every experiment's hypothesis allows no wrong outcome, with a 95th percentile latency of at most 45 s (90 s for the burst).
