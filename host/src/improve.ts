// The improvement loop: Q knows itself, learns from use and evolves, every step measured, decided by its own
// proved kernel, and recorded under a BLAKE3 label. Fully automatic, and fully verifiable.
//
// Why: an agent that only answers stays as good as its first day. Q gets better from use in four ways:
//   Knowledge  A question Q refused is a gap, recorded with the link to the question. When a member answers it in a
//              reply to that question, the reply fills the gap (decision 21): the reply is searched by the question it
//              answers, so the next person who asks gets the member's answer, cited.
//   Tests      An answer a member approves (a 👍 or ✅ on Q's reply) and a filled gap each become a regression test
//              (decision 22, grounded answers only). The test set grows from real use, never by hand.
//   Evolution  Q's tunable settings are a genome: a record named by its BLAKE3 label, naming its parent. Every day
//              Q measures its current genome and one mutation of it, drawn from BLAKE3, on the same tests plus
//              refusal probes, in a shadow pipeline. The kernel promotes the mutation only when it measurably beats
//              the current genome (decision 24, Policy.neverPromoteWorse), and Q adopts it at once.
//   Self       Every day Q writes a review: who it is (its holo, model, commit, vectors, community pin, index,
//              genome), what it does not know, what it learned, how it measured, and what it proposes. Each review
//              names the one before it by its BLAKE3 label: a chain of self-portraits no one can rewrite.
//
// What Q never does here: change its own rules or code. A proposal (add a source, fix a weakness an experiment found,
// look into a failing test) goes to the people who maintain Q, through /improve and the review's event. A change to
// the kernel reaches Q only as a build its own workflow signed, which the kernel checks at every start.
import { labelOf } from './address.ts';
import { measureQuestions, type Arm, type Expect, type Verdict } from './chaos.ts';
import type { CommunityPin } from './community.ts';
import type { Kernel } from './kernel.ts';
import { chunkOf, type Observed } from './memory.ts';
import type { Outgoing, Pipeline, Settings } from './pipeline.ts';
import type { Embedder } from './providers.ts';
import { loopRecord, type SearchIndex } from './search.ts';
import type { Store } from './store.ts';

/** The reactions that approve an answer. */
export const APPROVALS = new Set(['👍', '✅', '💯', '🎯']);
const REFUSALS = new Set(['not grounded', 'declined']);
const ANSWERED = new Set(['answer', 'answer with notice']);
const DAY = 86_400_000;

export const REVIEW_EVENT = 'org.uorfoundation.q.review';

/** The settings Q may evolve, and the bounds no mutation leaves. */
export type Genes = Pick<Settings, 'mediumSimilarity' | 'highSimilarity' | 'retrieve'>;
export const GENE_BOUNDS = { mediumSimilarity: [0.3, 0.85], highSimilarity: [0.35, 0.95], retrieve: [3, 12] } as const;
const GENES = ['mediumSimilarity', 'highSimilarity', 'retrieve'] as const;

/** One step from a genome, chosen by BLAKE3 of the seed: which gene, and which way. Always within bounds. */
export function mutate(genes: Genes, seed: string): Genes {
  const h = parseInt(labelOf({ type: 'mutation', seed }).slice(-8), 16);
  const gene = GENES[h % GENES.length];
  const sign = Math.floor(h / GENES.length) % 2 === 0 ? 1 : -1;
  const next = { ...genes };
  const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));
  if (gene === 'retrieve') next.retrieve = clamp(genes.retrieve + sign, GENE_BOUNDS.retrieve);
  else next[gene] = Math.round(clamp(genes[gene] + sign * 0.02, GENE_BOUNDS[gene]) * 100) / 100;
  // The high band stays above the medium band.
  if (next.highSimilarity < next.mediumSimilarity + 0.05) next.highSimilarity = Math.round(Math.min(GENE_BOUNDS.highSimilarity[1], next.mediumSimilarity + 0.05) * 100) / 100;
  return next;
}

export interface LoopDeps {
  kernel: Kernel;
  store: Store;
  index: SearchIndex;
  embedder: Embedder;
  community(): { pin: CommunityPin };
  /** A shadow pipeline over production, with these settings: its writes stay in memory, its answers go to no one. */
  shadow(settings?: Settings): Pipeline;
  /** The live settings, and how to adopt evolved genes into them. */
  settings(): Settings;
  adopt(genes: Genes): void;
  /** Real questions being worked on or waiting. */
  load(): number;
  /** The latest verdict of each chaos experiment. */
  experiments(): { name: string; result: string; verdict: Verdict }[];
  /** Questions Q must keep refusing, so no evolution buys answers by loosening grounding. */
  probes: { text: string; expect: Expect }[];
  emit(event: object): void;
  now(): number;
  evaluation: { size: number; maxErrorPct: number; maxP95Seconds: number };
  /** Members' requests: how many must support one before it is filed, and how it is filed to the community. */
  requests: { threshold: number; file?(request: { label: string; kind: string; text: string; supporters: number }): Promise<string> };
}

const KINDS = new Set(['idea', 'problem', 'praise']);
/** Two requests this alike are one request: the second member supports the first. */
const ALIKE = 0.86;
const cosine = (a: number[], b: number[]) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

interface Gap { label: string; question: string; channel: string; asked: number; author: string; filled: string | null }
interface Delivery { answer: string; question: string; grounded: boolean }
interface Test { question: string; source: 'approval' | 'gap-fill'; added: number }
interface Proposal { kind: 'knowledge' | 'fix' | 'regression' | 'request'; subject: string; why: string }
interface Measured { label: string; arm: Arm | null; outcome: 'measured' | 'waited' | 'aborted' }

export interface Review {
  type: 'review';
  spec: 'uor-q/review/1';
  previous: string | null;
  at: number;
  self: { holo: string; model: string; commit: string | null; vectors: number; community: { holo: string; commit: string }; chunks: number; genome: string | null };
  gaps: { open: number; filled: number };
  requests: { open: number; filed: number };
  tests: number;
  evaluation: string | null;
  evolution: string | null;
  experiments: { name: string; result: string; verdict: Verdict }[];
  proposals: Proposal[];
  [member: string]: unknown;
}

export class Loop {
  #deps: LoopDeps;
  constructor(deps: LoopDeps) { this.#deps = deps; }

  async #keep(item: { type: string; [member: string]: unknown }) {
    const label = await this.#deps.store.put('private', item);
    loopRecord(this.#deps.index, label, item);
    return label;
  }
  async #live(label: string | undefined) {
    return Boolean(label) && (await this.#deps.store.has('private', label!));
  }
  #genes(): Genes {
    const { mediumSimilarity, highSimilarity, retrieve } = this.#deps.settings();
    return { mediumSimilarity, highSimilarity, retrieve };
  }

  /** At start: adopt the latest genome, or record the operator's settings as the first one, the root of the lineage. */
  async restore(): Promise<string> {
    const latest = this.#deps.index.loopGet<{ label: string }>('genome', 'latest');
    const genome = latest && (await this.#deps.store.get('private', latest.label));
    if (genome) {
      this.#deps.adopt(genome.genes as Genes);
      return latest!.label;
    }
    return this.#keep({ type: 'genome', spec: 'uor-q/genome/1', parent: null, genes: this.#genes(), evolution: null, at: this.#deps.now() });
  }

  /** Q replied on Discord. A refusal becomes a gap; every turn's delivery is kept, so an approval can find its answer. */
  async delivered(d: { questionUrl?: string; sentUrl: string; question: string; channelId: string; authorId: string; reply: Outgoing }) {
    if (!d.reply.answer) return;
    const now = this.#deps.now();
    if (d.questionUrl && REFUSALS.has(d.reply.decision)) {
      await this.#keep({ type: 'gap', spec: 'uor-q/gap/1', question: d.question, url: d.questionUrl, channel: d.channelId, author: d.authorId, asked: now, answer: d.reply.answer });
    }
    const grounded = ANSWERED.has(d.reply.decision) && d.reply.citations.length > 0;
    await this.#keep({ type: 'delivery', spec: 'uor-q/delivery/1', answer: d.reply.answer, url: d.sentUrl, question: d.question, author: d.authorId, grounded, at: now });
  }

  /** A message was offered to the memory. If it is a member's reply to a question Q could not answer, it may fill the gap. */
  async observed(message: Observed, decision: 'index' | 'skip'): Promise<'fill' | 'skip' | undefined> {
    if (!message.replyTo) return undefined;
    const gap = this.#deps.index.loopGet<Gap>('gap', message.replyTo);
    const open = Boolean(gap && !gap.filled && (await this.#live(gap.label)));
    const verdict = await this.#deps.kernel.gapFill(decision === 'index', message.origin === 'conversation', open);
    if (verdict !== 'fill' || !gap) return verdict;
    const text = message.text.trim();
    const chunk = labelOf(chunkOf(message, text));
    const now = this.#deps.now();
    const fill = await this.#keep({ type: 'gap-fill', spec: 'uor-q/gap-fill/1', gap: gap.label, chunk, url: message.replyTo, author: message.authorId, filled: now });
    await this.#deps.store.link('private', { source: fill, target: gap.label, relation: 'refers-to' });
    await this.#deps.store.link('private', { source: fill, target: chunk, relation: 'derived-from' });
    // The member's answer is found by the question it answers.
    const [vector] = await this.#deps.embedder.embed([`${gap.question}\n${text}`]);
    this.#deps.index.revector(chunk, vector);
    await this.#test(gap.question, 'gap-fill', fill, gap.author);
    return verdict;
  }

  /** A reaction on a message Q sent. A human's approval of a grounded answer makes the question a regression test. */
  async approved(sentUrl: string, emoji: string | null, human: boolean): Promise<'admit' | 'skip'> {
    const delivery = this.#deps.index.loopGet<Delivery>('delivery', sentUrl);
    const verdict = await this.#deps.kernel.testAdmit(APPROVALS.has(emoji ?? ''), human, Boolean(delivery?.grounded && (await this.#live(delivery.answer))));
    if (verdict === 'admit' && delivery) await this.#test(delivery.question, 'approval', delivery.answer, null);
    return verdict;
  }

  #vectors = new Map<string, number[]>();

  /** The distinct members whose live feedback supports a request. */
  async #supporters(request: string): Promise<Set<string>> {
    const who = new Set<string>();
    for (const f of this.#deps.index.loopAll<{ request: string; author: string }>('feedback')) {
      if (f.value.request === request && (await this.#live(f.key))) who.add(f.value.author);
    }
    return who;
  }

  /**
   * A member's feedback or request, sent with /feedback, which says it goes to the community without their name.
   * It joins the open request it is most alike, or opens one. When enough members support it, the kernel files it
   * to the community as an issue (decision 25), once, named by its BLAKE3 label.
   */
  async feedback(f: { kind: string; text: string; authorId: string; channelId: string }): Promise<string> {
    const text = f.text.trim().slice(0, 1500);
    if (!text) return 'Write what you would like Q to do better, or what went wrong.';
    const kind = KINDS.has(f.kind) ? f.kind : 'idea';
    const { index, embedder, kernel, now } = this.#deps;
    const [vector] = await embedder.embed([text]);
    let best: { label: string; likeness: number } | null = null;
    for (const r of index.loopAll<{ kind: string; text: string; filed: string | null }>('request')) {
      if (r.value.kind !== kind || !(await this.#live(r.key))) continue;
      let v = this.#vectors.get(r.key);
      if (!v) { [v] = await embedder.embed([r.value.text]); this.#vectors.set(r.key, v); }
      const likeness = cosine(vector, v);
      if (likeness >= ALIKE && (!best || likeness > best.likeness)) best = { label: r.key, likeness };
    }
    const request = best?.label ?? (await this.#keep({ type: 'request', spec: 'uor-q/request/1', kind, text, author: f.authorId, at: now() }));
    if (!best) this.#vectors.set(request, vector);
    await this.#keep({ type: 'feedback', spec: 'uor-q/feedback/1', request, kind, text, author: f.authorId, channel: f.channelId, consented: true, at: now() });
    const supporters = (await this.#supporters(request)).size;
    const state = index.loopGet<{ text: string; filed: string | null }>('request', request)!;
    const threshold = this.#deps.requests.threshold;
    let filed = state.filed;
    if ((await kernel.fileRequest(true, supporters, threshold, Boolean(filed))) === 'file' && this.#deps.requests.file) {
      try {
        filed = await this.#deps.requests.file({ label: request, kind, text: state.text, supporters });
        await this.#keep({ type: 'request-filed', spec: 'uor-q/request-filed/1', request, issue: filed, supporters, at: now() });
      } catch (error) {
        console.error(JSON.stringify({ event: 'error', message: `filing ${request}: ${String(error)}` }));
      }
    }
    const joined = best ? `It joins a request ${supporters - 1} other member${supporters === 2 ? '' : 's'} made.` : 'It opens a new request.';
    const where = filed ? `It is filed for the community: <${filed}>.`
      : supporters >= threshold ? 'It has enough support, and goes to the community as soon as filing is set up.'
      : `It goes to the community, without your name, once ${threshold} members ask for it.`;
    return `Thank you. Recorded as ${kind} \`${request.slice(0, 19)}\`. ${joined} ${where}`;
  }

  /** A 👎 on an answer Q sent: counted against that answer in the review. It carries no text, so it is never filed. */
  async disapproved(sentUrl: string, human: boolean): Promise<'recorded' | 'skip'> {
    const delivery = this.#deps.index.loopGet<Delivery>('delivery', sentUrl);
    if (!human || !delivery || !(await this.#live(delivery.answer))) return 'skip';
    await this.#keep({ type: 'feedback', spec: 'uor-q/feedback/1', request: null, kind: 'problem', text: null, about: delivery.answer, author: null, consented: false, at: this.#deps.now() });
    return 'recorded';
  }

  async #test(question: string, source: Test['source'], from: string, author: string | null) {
    // One test per question: the same question approved twice is one test.
    if (this.#deps.index.loopAll<Test>('test').some((t) => t.value.question === question)) return;
    await this.#keep({ type: 'test-case', spec: 'uor-q/test-case/1', question, expect: 'answered', source, from, author, added: this.#deps.now() });
  }

  /** Today's tests: a sample drawn from BLAKE3 of the day and each test's label, so every test is measured in turn. */
  async #sample(): Promise<{ key: string; value: Test }[]> {
    const all = [];
    for (const t of this.#deps.index.loopAll<Test>('test')) if (await this.#live(t.key)) all.push(t);
    const day = Math.floor(this.#deps.now() / DAY);
    return all.map((t) => ({ t, order: labelOf({ type: 'sample', day, test: t.key }) })).sort((a, b) => a.order.localeCompare(b.order)).slice(0, this.#deps.evaluation.size).map((s) => s.t);
  }

  /** Measure one genome on the sample and the probes, while no real question is in progress (decision 23). */
  async #measure(sample: { key: string; value: Test }[], genes: Genes, role: 'current' | 'candidate'): Promise<Measured> {
    const { kernel, now, evaluation } = this.#deps;
    const may = async () => (await kernel.evalRun(this.#deps.load() > 0, sample.length > 0)) === 'run';
    const questions = [...sample.map((t) => ({ text: t.value.question, expect: 'answered' as const })), ...this.#deps.probes];
    let arm: Arm | null = null;
    let outcome: Measured['outcome'] = 'waited';
    if (await may()) {
      const measured = await measureQuestions(kernel, questions, evaluation, this.#deps.shadow({ ...this.#deps.settings(), ...genes }), may);
      if (measured === 'aborted') outcome = 'aborted';
      else [arm, outcome] = [measured, 'measured'];
    }
    const label = await this.#keep({ type: 'evaluation', spec: 'uor-q/evaluation/1', role, genes, tests: sample.map((t) => t.key), probes: this.#deps.probes.length, outcome, arm, kernel: kernel.holo, at: now() });
    return { label, arm, outcome };
  }

  /** Measure the current genome, for the review. */
  async evaluate(): Promise<Measured> {
    return this.#measure(await this.#sample(), this.#genes(), 'current');
  }

  /** Try one mutation against the current genome on the same questions; the kernel decides, and a winner is adopted. */
  async #evolve(sample: { key: string; value: Test }[], current: Measured): Promise<{ label: string; decision: 'promote' | 'keep'; genome: string | null } | null> {
    if (!current.arm || sample.length < 3) return null;
    const { kernel, index, now, evaluation } = this.#deps;
    const parent = index.loopGet<{ label: string }>('genome', 'latest')?.label ?? null;
    const genes = this.#genes();
    const candidate = mutate(genes, `${parent ?? 'origin'}:${Math.floor(now() / DAY)}`);
    const trial = await this.#measure(sample, candidate, 'candidate');
    if (!trial.arm) return null;
    const decision = await kernel.promote(trial.arm.errorPct, current.arm.errorPct, trial.arm.p95Seconds, current.arm.p95Seconds, evaluation.maxP95Seconds, trial.arm.breaches);
    const label = await this.#keep({ type: 'evolution', spec: 'uor-q/evolution/1', parent, current: genes, candidate, evaluations: { current: current.label, candidate: trial.label }, decision, at: now() });
    let genome: string | null = null;
    if (decision === 'promote') {
      genome = await this.#keep({ type: 'genome', spec: 'uor-q/genome/1', parent, genes: candidate, evolution: label, at: now() });
      if (parent) await this.#deps.store.link('private', { source: genome, target: parent, relation: 'derived-from' });
      await this.#deps.store.link('private', { source: genome, target: label, relation: 'evidence-provenance' });
      this.#deps.adopt(candidate);
    }
    return { label, decision, genome };
  }

  /** Today's review: who Q is, what it knows it does not know, what it learned, how it measured, what it proposes. */
  async review(evaluated: Measured | null, evolution: { label: string } | null = null): Promise<{ label: string; review: Review }> {
    const { kernel, index, now } = this.#deps;
    const gaps: Gap[] = [];
    for (const g of index.loopAll<Gap>('gap')) if (await this.#live(g.value.label)) gaps.push(g.value);
    const open = gaps.filter((g) => !g.filled).sort((a, b) => a.asked - b.asked);
    let tests = 0;
    for (const t of index.loopAll<Test>('test')) if (await this.#live(t.key)) tests++;
    const experiments = this.#deps.experiments();
    const requests: { label: string; supporters: number; filed: string | null }[] = [];
    for (const r of index.loopAll<{ filed: string | null }>('request')) {
      if (await this.#live(r.key)) requests.push({ label: r.key, supporters: (await this.#supporters(r.key)).size, filed: r.value.filed });
    }
    const asked = requests.filter((r) => !r.filed).sort((a, b) => b.supporters - a.supporters);
    const proposals: Proposal[] = [
      ...asked.slice(0, 10).map((r): Proposal => ({ kind: 'request', subject: r.label, why: `Asked by ${r.supporters} member${r.supporters === 1 ? '' : 's'}.` })),
      ...open.filter((g) => now() - g.asked >= DAY).slice(0, 10).map((g): Proposal => ({ kind: 'knowledge', subject: g.label, why: 'Asked and still unanswered: add a source that answers it, or answer it in a reply to the question.' })),
      ...experiments.filter((e) => e.verdict === 'disproved').map((e): Proposal => ({ kind: 'fix', subject: e.result, why: `${e.name}: the steady state did not hold under the fault.` })),
      ...(evaluated?.arm && evaluated.arm.steady === 'disturbed' ? [{ kind: 'regression' as const, subject: evaluated.label, why: `${evaluated.arm.wrong} of ${evaluated.arm.questions} questions did not get the outcome they used to.` }] : []),
    ];
    const previous = index.loopGet<{ label: string }>('review', 'latest')?.label ?? null;
    const pin = this.#deps.community().pin;
    const review: Review = {
      type: 'review', spec: 'uor-q/review/1', previous, at: now(),
      self: { holo: kernel.holo, model: kernel.model, commit: kernel.commit, vectors: kernel.vectors, community: { holo: pin.holo, commit: pin.commit }, chunks: index.count(), genome: index.loopGet<{ label: string }>('genome', 'latest')?.label ?? null },
      gaps: { open: open.length, filled: gaps.length - open.length }, requests: { open: asked.length, filed: requests.length - asked.length }, tests, evaluation: evaluated?.label ?? null, evolution: evolution?.label ?? null, experiments, proposals,
    };
    const label = await this.#keep(review);
    if (previous) await this.#deps.store.link('private', { source: label, target: previous, relation: 'derived-from' });
    if (evaluated) await this.#deps.store.link('private', { source: label, target: evaluated.label, relation: 'derived-from' });
    // The public trace: counts and public identities only, no label of a record that holds a member's words.
    this.#deps.emit({
      specversion: '1.0', type: REVIEW_EVENT, source: 'https://github.com/UOR-Foundation/q', id: labelOf({ type: 'event', eventType: REVIEW_EVENT, at: review.at, gaps: review.gaps, tests }),
      time: new Date(review.at).toISOString(), datacontenttype: 'application/json',
      data: {
        kernel: kernel.holo, community: pin.holo, chunks: review.self.chunks, gaps: review.gaps, requests: review.requests, tests,
        evaluation: evaluated?.arm ? { errorPct: evaluated.arm.errorPct, p95Seconds: evaluated.arm.p95Seconds, steady: evaluated.arm.steady } : null,
        proposals: { request: proposals.filter((p) => p.kind === 'request').length, knowledge: proposals.filter((p) => p.kind === 'knowledge').length, fix: proposals.filter((p) => p.kind === 'fix').length, regression: proposals.filter((p) => p.kind === 'regression').length },
      },
    });
    return { label, review };
  }

  /** One turn of the loop: measure, evolve, then review. */
  async daily() {
    const sample = await this.#sample();
    const current = await this.#measure(sample, this.#genes(), 'current');
    const evolution = await this.#evolve(sample, current);
    const reviewed = await this.review(current, evolution);
    return { ...reviewed, evolution };
  }

  /** The latest review, for /improve: admins only, and only to the admin who asked. */
  async summary(): Promise<string> {
    const { store, index } = this.#deps;
    const latest = index.loopGet<{ label: string }>('review', 'latest');
    const review = latest && ((await store.get('private', latest.label)) as Review | undefined);
    if (!review) return 'No review yet: the first is written about twenty minutes after Q starts, then once a day.';
    const evaluation = review.evaluation ? await store.get('private', review.evaluation) : undefined;
    const arm = evaluation?.arm as Arm | null | undefined;
    const evolution = review.evolution ? await store.get('private', review.evolution) : undefined;
    const genome = review.self.genome ? await store.get('private', review.self.genome) : undefined;
    // The lineage: how many genomes back to the operator's settings.
    let generations = 0;
    for (let g = genome; g?.parent; g = await store.get('private', String(g.parent))) generations++;
    const genes = genome?.genes as Genes | undefined;
    const lines = [
      `**Improvement loop** · review \`${latest!.label.slice(0, 19)}\`${review.previous ? ` · after \`${review.previous.slice(0, 19)}\`` : ' · the first'}`,
      `Self: kernel \`${review.self.holo.slice(0, 19)}\` (${review.self.vectors} vectors replayed${review.self.commit ? `, signed build of ${review.self.commit.slice(0, 7)}` : ''}), community ${review.self.community.commit.slice(0, 7)}, ${review.self.chunks} chunks indexed.`,
      genes ? `Genome: generation ${generations}, \`${review.self.genome!.slice(0, 19)}\`: medium ${genes.mediumSimilarity}, high ${genes.highSimilarity}, retrieve ${genes.retrieve}.` : 'Genome: none yet.',
      evolution ? `Evolution: tried ${JSON.stringify(evolution.candidate)}, ${evolution.decision === 'promote' ? 'promoted: it beat the current genome' : 'kept the current genome'}.` : 'Evolution: not tried (fewer than three tests, or no measurement).',
      `Gaps: ${review.gaps.open} open, ${review.gaps.filled} filled by members.`,
      `Requests: ${review.requests?.open ?? 0} open, ${review.requests?.filed ?? 0} filed to the community.`,
      `Tests: ${review.tests}, from approved answers and filled gaps.`,
      arm ? `Evaluation: ${arm.questions - arm.wrong} of ${arm.questions} right (tests and refusal probes), p95 ${arm.p95Seconds} s, ${arm.steady}.` : `Evaluation: ${evaluation ? String(evaluation.outcome) : 'none yet'}.`,
      `Experiments: ${review.experiments.map((e) => `${e.name} ${e.verdict}`).join(', ') || 'none tried yet'}.`,
    ];
    if (review.proposals.length) {
      lines.push('', '**Proposals**');
      for (const [i, p] of review.proposals.entries()) {
        const subject = p.kind === 'knowledge' || p.kind === 'request' ? await store.get('private', p.subject) : undefined;
        const asked = !subject ? '' : p.kind === 'request' ? ` ${String(subject.kind)}: “${String(subject.text).slice(0, 160)}”` : ` “${String(subject.question).slice(0, 160)}” in <#${subject.channel}>`;
        lines.push(`${i + 1}. ${p.kind}:${asked} ${p.why}`);
      }
    } else {
      lines.push('', 'No proposals: nothing open long enough, nothing disproved, no regression.');
    }
    return lines.join('\n');
  }
}
