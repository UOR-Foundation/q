// Chaos engineering for Q (https://principlesofchaos.org), coordinated by UOR-Foundation/community.
//
// Why: Q depends on a language model, an embedder, the community holo and Discord, and each of them fails in
// production. An experiment is how Q earns confidence that it withstands those failures, instead of assuming it.
//
// How, principle by principle:
//   Steady state     Measured on Q's output only: the share of questions whose outcome is wrong (an answer
//                    without a citation, a refusal where an answer was due, an error) and the 95th percentile
//                    latency. The kernel judges it (decision 20), and a broken invariant is never steady.
//   Real events      Faults where real ones happen, at the network: the model busy (429), down, slow or
//                    answering malformed; the embedder down; a burst of questions at once.
//   In production    On the production host, model, embedder, index, community and kernel, through a shadow
//                    pipeline: its writes stay in memory and its answers go to no one.
//   Automated        Every experiment is tried on a schedule; each try leaves a record and an event.
//   Blast radius     The kernel lets an experiment run only on the shadow, never on live traffic, and it stops
//                    the experiment the moment a real question is waiting (decision 19).
//
// What, with BLAKE3: an experiment is a JSON record, and its kappa label is its identity. The community approves
// that exact label in automation/chaos-approvals.json, read at the commit Q pins: change one byte and it is a new
// experiment nobody approved. Which calls fail is drawn from BLAKE3 of the label and the call's index, so a run
// is replayable fault for fault. The result is a record whose label is its event's id, linked to the experiment
// it ran (derived-from) and to the kernel and community holos that decided it (certified-by).
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isLabel, labelOf, type Item } from './address.ts';
import type { CommunityPin } from './community.ts';
import type { Kernel } from './kernel.ts';
import type { Incoming, Outgoing, Pipeline } from './pipeline.ts';
import type { Transport } from './providers.ts';
import { EVENT_SOURCE } from './records.ts';
import type { SearchIndex } from './search.ts';
import type { Edge, Namespace, Store } from './store.ts';

export const FAULTS = ['llm-busy', 'llm-down', 'llm-slow', 'llm-malformed', 'embedder-down', 'burst'] as const;
export type Fault = (typeof FAULTS)[number];
export type Expect = 'answered' | 'refused' | 'empty';

export interface Experiment extends Item {
  type: 'experiment';
  spec: 'uor-q/experiment/1';
  name: string;
  /** The real-world event this stands for, and why it matters. */
  why: string;
  /** The steady state the experiment tries to disprove. */
  hypothesis: { maxErrorPct: number; maxP95Seconds: number };
  /** The fault, and the share of calls it strikes (for a burst: how many copies of each question at once). */
  variable: { fault: Fault; ratePct: number };
  questions: { text: string; expect: Expect }[];
}

/** One arm's measured output. Counts and durations only: no question, no answer. */
export interface Arm {
  questions: number;
  wrong: number;
  errorPct: number;
  p95Seconds: number;
  breaches: number;
  outcomes: Record<string, number>;
  steady: 'steady' | 'disturbed';
}

export type Verdict = 'confirmed' | 'disproved' | 'held' | 'aborted';

export interface Result extends Item {
  type: 'experiment-result';
  spec: 'uor-q/experiment-result/1';
  experiment: string;
  name: string;
  fault: Fault;
  kernel: string;
  community: { holo: string; commit: string };
  verdict: Verdict;
  reason: string;
  control: Arm | null;
  experimental: Arm | null;
  started: number;
  ended: number;
}

export const EXPERIMENT_EVENT = 'org.uorfoundation.q.experiment';
export interface ExperimentEvent {
  specversion: '1.0'; type: typeof EXPERIMENT_EVENT; source: string; id: string; time: string; datacontenttype: 'application/json';
  data: { experiment: string; name: string; fault: Fault; verdict: Verdict; control: Pick<Arm, 'errorPct' | 'p95Seconds' | 'breaches'> | null; experimental: Pick<Arm, 'errorPct' | 'p95Seconds' | 'breaches'> | null; kernel: string; community: string };
}

/** Read and check every experiment in a folder. A file that is not one is refused, not guessed at. */
export async function loadExperiments(dir: string): Promise<{ label: string; experiment: Experiment }[]> {
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
  } catch {
    return [];
  }
  return Promise.all(names.map(async (name) => {
    const experiment = JSON.parse(await readFile(join(dir, name), 'utf8')) as Experiment;
    const fine = experiment.type === 'experiment' && experiment.spec === 'uor-q/experiment/1' && typeof experiment.name === 'string'
      && FAULTS.includes(experiment.variable?.fault) && Number.isInteger(experiment.variable?.ratePct)
      && Number.isInteger(experiment.hypothesis?.maxErrorPct) && Number.isInteger(experiment.hypothesis?.maxP95Seconds)
      && Array.isArray(experiment.questions) && experiment.questions.length > 0
      && experiment.questions.every((q) => typeof q.text === 'string' && ['answered', 'refused', 'empty'].includes(q.expect));
    if (!fine) throw new Error(`chaos refused: ${name} is not a uor-q/experiment/1 record`);
    return { label: labelOf(experiment), experiment };
  }));
}

/** Whether call number `call` of an experiment is struck: BLAKE3 of the label and the index, so a run replays exactly. */
export function strikes(experiment: string, call: number, ratePct: number): boolean {
  return parseInt(labelOf({ type: 'fault', experiment, call }).slice(-8), 16) % 100 < ratePct;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A network that fails the way the fault says, on the calls BLAKE3 strikes, and is the real one otherwise. */
export function faulty(base: Transport, fault: Fault, experiment: string, ratePct: number, slowMs = 20_000): Transport {
  let call = 0;
  return (async (input: Parameters<Transport>[0], init?: Parameters<Transport>[1]) => {
    if (!strikes(experiment, call++, ratePct)) return base(input, init);
    switch (fault) {
      case 'llm-busy': return new Response('busy', { status: 429, headers: { 'retry-after': '1' } });
      case 'embedder-down': return new Response('unavailable', { status: 503 });
      case 'llm-down': throw new TypeError('fetch failed');
      case 'llm-slow': await sleep(slowMs); return base(input, init);
      case 'llm-malformed': return new Response('{"choices":[{"message":{"content":', { status: 200, headers: { 'content-type': 'application/json' } });
      default: return base(input, init);
    }
  }) as Transport;
}

/** The production store, read through; every write stays in this object. */
export class ShadowStore implements Store {
  #base: Store;
  #items = { public: new Map<string, Item>(), private: new Map<string, Item>() };
  #edges = { public: [] as Edge[], private: [] as Edge[] };
  constructor(base: Store) { this.#base = base; }
  async put(namespace: Namespace, item: Item) { const label = labelOf(item); this.#items[namespace].set(label, item); return label; }
  async get(namespace: Namespace, label: string) { return this.#items[namespace].get(label) ?? this.#base.get(namespace, label); }
  async has(namespace: Namespace, label: string) { return this.#items[namespace].has(label) || this.#base.has(namespace, label); }
  async link(namespace: Namespace, edge: Edge) { this.#edges[namespace].push(edge); }
  async edgesTo(namespace: Namespace, label: string) { return [...(await this.#base.edgesTo(namespace, label)), ...this.#edges[namespace].filter((e) => e.target === label)]; }
  async delete(namespace: Namespace, label: string) { this.#items[namespace].delete(label); }
  async labels(namespace: Namespace) { return [...new Set([...(await this.#base.labels(namespace)), ...this.#items[namespace].keys()])]; }
}

/** The production index, searched as it is; nothing is added to it, and no earlier answer is reused, so every question is worked. */
export function shadowIndex(base: SearchIndex): SearchIndex {
  const quiet = { memoGet: () => undefined, memoSet: () => {}, memoDelete: () => {}, add: () => {}, remove: () => {} } as Record<string, unknown>;
  return new Proxy(base, {
    get(target, key, receiver) {
      if (typeof key === 'string' && key in quiet) return quiet[key];
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export interface ChaosDeps {
  kernel: Kernel;
  community(): { pin: CommunityPin; experiments: ReadonlySet<string> };
  /** A shadow pipeline over production, its model and embedder reaching the network through these. */
  shadow(llm: Transport, embedder: Transport, concurrency: number): Pipeline;
  /** Real questions being worked on or waiting. */
  load(): number;
  /** Where results are kept: the production store, public namespace. They hold no content. */
  store: Store;
  emit(event: ExperimentEvent): void;
  now(): number;
  /** The real network the faults are laid over: fetch, unless a test supplies one. */
  network?: Transport;
}

const ANSWERED = new Set(['answer', 'answer with notice']);
const REFUSED = new Set(['not grounded', 'declined']);
const outcomeOf = (reply: Outgoing | undefined) => (!reply ? 'silent' : reply.decision);
const meets = (expect: Expect, reply: Outgoing | undefined) =>
  expect === 'answered' ? Boolean(reply && ANSWERED.has(reply.decision) && reply.citations.length > 0)
  : expect === 'refused' ? Boolean(reply && REFUSED.has(reply.decision))
  : reply?.decision === 'empty';

/** Ask every question once (a burst: `copies` of each, all at once), checking before each that the kernel lets it go on. */
async function measure(deps: ChaosDeps, experiment: Experiment, pipeline: Pipeline, approved: boolean, copies: number): Promise<Arm | 'aborted'> {
  const runs: { ms: number; outcome: string; right: boolean; breach: boolean }[] = [];
  const ask = async (text: string, expect: Expect, i: number) => {
    if ((await deps.kernel.experiment(approved, 'shadow', deps.load() > 0)) !== 'run') return false;
    const message: Incoming = {
      channel: { kind: 'text', visibility: 'everyone', label: 'public', install: 'admin', intent: 'granted' },
      channelId: 'chaos', authorId: `chaos-${i}`, role: 'member', trigger: 'mention', text,
    };
    const started = performance.now();
    let reply: Outgoing | undefined;
    let outcome: string;
    try {
      reply = await pipeline.handle(message);
      outcome = outcomeOf(reply);
    } catch {
      outcome = 'error';
    }
    runs.push({
      ms: performance.now() - started, outcome, right: outcome !== 'error' && meets(expect, reply),
      breach: Boolean(reply && ANSWERED.has(reply.decision) && reply.citations.length === 0),
    });
    return true;
  };
  const asked = copies > 1
    ? await Promise.all(experiment.questions.flatMap((q, i) => Array.from({ length: copies }, (_, c) => ask(q.text, q.expect, i * copies + c))))
    : await (async () => { const done: boolean[] = []; for (const [i, q] of experiment.questions.entries()) { const ok = await ask(q.text, q.expect, i); done.push(ok); if (!ok) break; } return done; })();
  if (asked.some((ok) => !ok)) return 'aborted';
  const wrong = runs.filter((r) => !r.right).length;
  const errorPct = (100 * wrong) / runs.length;
  const sorted = runs.map((r) => r.ms).sort((a, b) => a - b);
  const p95Seconds = sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)] / 1000;
  const breaches = runs.filter((r) => r.breach).length;
  const outcomes: Record<string, number> = {};
  for (const r of runs) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
  const steady = await deps.kernel.steady(errorPct, experiment.hypothesis.maxErrorPct, p95Seconds, experiment.hypothesis.maxP95Seconds, breaches);
  return { questions: runs.length, wrong, errorPct: Math.round(errorPct), p95Seconds: Math.round(p95Seconds * 10) / 10, breaches, outcomes, steady };
}

/**
 * Try one experiment: the kernel's gate first, then the control arm (no fault), then the experimental arm (the
 * fault). No experiment on a system that is not steady without it. The verdict: confirmed when the steady state
 * held under the fault, disproved when it did not, which is a weakness found.
 */
export async function runExperiment(deps: ChaosDeps, experiment: Experiment): Promise<{ label: string; result: Result }> {
  const label = labelOf(experiment);
  if (!isLabel(label)) throw new Error('chaos refused: an experiment without a BLAKE3 label');
  const community = deps.community();
  const approved = community.experiments.has(label);
  const started = deps.now();
  const { fault, ratePct } = experiment.variable;
  const network = deps.network ?? fetch;
  let control: Arm | null = null;
  let experimental: Arm | null = null;
  let verdict: Verdict;
  let reason: string;

  const gate = await deps.kernel.experiment(approved, 'shadow', deps.load() > 0);
  if (gate !== 'run') {
    verdict = gate === 'abort' ? 'aborted' : 'held';
    reason = gate === 'abort' ? 'a real question was waiting' : 'the community has not approved this exact experiment';
  } else {
    const burst = fault === 'burst';
    const concurrency = burst ? 2 : 1;
    const plain = await measure(deps, experiment, deps.shadow(network, network, concurrency), approved, 1);
    if (plain === 'aborted') {
      [verdict, reason] = ['aborted', 'a real question was waiting'];
    } else if ((control = plain).steady !== 'steady') {
      [verdict, reason] = ['held', 'Q was not in its steady state without the fault, so the fault would prove nothing'];
    } else {
      const llm = fault.startsWith('llm-') ? faulty(network, fault, label, ratePct) : network;
      const embedder = fault === 'embedder-down' ? faulty(network, fault, label, ratePct) : network;
      const tried = await measure(deps, experiment, deps.shadow(llm, embedder, concurrency), approved, burst ? Math.max(2, ratePct) : 1);
      if (tried === 'aborted') {
        [verdict, reason] = ['aborted', 'a real question was waiting'];
      } else {
        experimental = tried;
        [verdict, reason] = tried.steady === 'steady'
          ? ['confirmed', 'the steady state held under the fault']
          : ['disproved', 'the steady state did not hold under the fault: a weakness to fix'];
      }
    }
  }

  const result: Result = {
    type: 'experiment-result', spec: 'uor-q/experiment-result/1', experiment: label, name: experiment.name, fault,
    kernel: deps.kernel.holo, community: { holo: community.pin.holo, commit: community.pin.commit },
    verdict, reason, control, experimental, started, ended: deps.now(),
  };
  await deps.store.put('public', experiment);
  const resultLabel = await deps.store.put('public', result);
  await deps.store.link('public', { source: resultLabel, target: label, relation: 'derived-from' });
  await deps.store.link('public', { source: resultLabel, target: deps.kernel.holo, relation: 'certified-by' });
  await deps.store.link('public', { source: resultLabel, target: community.pin.holo, relation: 'certified-by' });
  const brief = (arm: Arm | null) => (arm ? { errorPct: arm.errorPct, p95Seconds: arm.p95Seconds, breaches: arm.breaches } : null);
  deps.emit({
    specversion: '1.0', type: EXPERIMENT_EVENT, source: EVENT_SOURCE, id: resultLabel, time: new Date(result.ended).toISOString(), datacontenttype: 'application/json',
    data: { experiment: label, name: experiment.name, fault, verdict, control: brief(control), experimental: brief(experimental), kernel: deps.kernel.holo, community: community.pin.holo },
  });
  return { label: resultLabel, result };
}
