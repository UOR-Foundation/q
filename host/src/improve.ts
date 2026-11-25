// The improvement loop: Q knows itself, learns from every interaction and evolves, every step measured, decided by
// its own proved kernel, and recorded under a BLAKE3 label. Automatic, and verifiable. docs/self-improvement.md.
//
// Why: an agent that only answers stays as good as its first day. Every interaction with Q is evidence about it:
//   Signals      A member's approval, disapproval, reply or confirmation on what Q said is a typed record naming the
//                delivery it judges (decision 26). Only a consenting human's counts, and words only from a readable
//                channel.
//   Knowledge    A question Q refused is a gap; a member's reply to it fills the gap (decision 21). A member who
//                replies to Q's answer with the right one and marks the answer wrong (👎) has written a correction:
//                once an admin wrote it or another member confirms it, Q learns it, or, where Q cited a more trusted
//                source, takes it to people as a dispute (decision 27). Learned, it is found by the question it answers.
//   Tests        An approved grounded answer, a filled gap and a learned correction each become a regression test
//                (decision 22). A test from a member's answer passes only when Q cites that answer.
//   Evolution    Q's tunable settings and the shape of its prompt are a genome: a record naming its parent. Every day Q
//                measures the current genome and one mutation of it, drawn from BLAKE3, on the same tests and refusal
//                probes, in a shadow pipeline. The kernel promotes the mutation only when it measurably wins and
//                leaks no refusal (decision 28); Q adopts it at once, and adopting the parent undoes it.
//   Self         Every day Q writes a review: its self-model (identity, knowledge, competence by class, limits, how it
//                changed), computed by self.ts from records it names, and chained to the review before it. Weak
//                classes go to people as proposals (decision 29).
//
// What Q never does here: change its own rules, code or prompts' wording. Proposals go to the people who maintain Q
// through /improve and the review's event. A change to the kernel reaches Q only as a build its own workflow signed.
import { labelOf } from './address.ts';
import { measureQuestions, type Arm, type Expect, type Measurable, type Verdict } from './chaos.ts';
import type { CommunityPin } from './community.ts';
import type { ChannelFacts, Kernel, SourceName } from './kernel.ts';
import { chunkOf, replyOf, type Observed } from './memory.ts';
import { promptOf, STYLES, type Outgoing, type Pipeline, type Settings } from './pipeline.ts';
import type { Embedder } from './providers.ts';
import { loopRecord, type SearchIndex } from './search.ts';
import { commitment, competenceOf, learningOf, type ClassCompetence, type Evidence } from './self.ts';
import type { Store } from './store.ts';

/** The reactions that approve something Q said, or a member's reply to it. */
export const APPROVALS = new Set(['👍', '✅', '💯', '🎯']);
/** The reactions that mark an answer wrong. With a reply from the same member, they make the reply a correction. */
export const DISAPPROVALS = new Set(['👎', '❌']);
const REFUSALS = new Set(['not grounded', 'declined']);
const ANSWERED = new Set(['answer', 'answer with notice']);
const DAY = 86_400_000;

export const REVIEW_EVENT = 'org.uorfoundation.q.review';

/** The settings Q may evolve, and the bounds no mutation leaves. */
export type Genes = Pick<Settings, 'mediumSimilarity' | 'highSimilarity' | 'retrieve' | 'style'>;
export const GENE_BOUNDS = { mediumSimilarity: [0.3, 0.85], highSimilarity: [0.35, 0.95], retrieve: [3, 12], style: [0, STYLES.length - 1] } as const;
const GENES = ['mediumSimilarity', 'highSimilarity', 'retrieve', 'style'] as const;

/** One step from a genome, chosen by BLAKE3 of the seed: which gene, and which way. Always within bounds. */
export function mutate(genes: Genes, seed: string): Genes {
  const h = parseInt(labelOf({ type: 'mutation', seed }).slice(-8), 16);
  const gene = GENES[h % GENES.length];
  const sign = Math.floor(h / GENES.length) % 2 === 0 ? 1 : -1;
  const next = { ...genes };
  const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));
  if (gene === 'retrieve' || gene === 'style') {
    // At a bound, step the other way: a mutation always changes the genome.
    const stepped = clamp(genes[gene] + sign, GENE_BOUNDS[gene]);
    next[gene] = stepped === genes[gene] ? clamp(genes[gene] - sign, GENE_BOUNDS[gene]) : stepped;
  } else next[gene] = Math.round(clamp(genes[gene] + sign * 0.02, GENE_BOUNDS[gene]) * 100) / 100;
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
  /** Whether a member asked to be forgotten, and so is never recorded again. */
  optedOut(member: string): Promise<boolean>;
  /** Remove an item Q holds only because of what it learned, when the learning is undone (memory.ts). */
  unlearn(label: string): Promise<void>;
  /** The latest verdict of each chaos experiment. */
  experiments(): { name: string; result: string; verdict: Verdict }[];
  /** Questions Q must keep refusing, so no evolution buys answers by loosening grounding. */
  probes: { text: string; expect: Expect }[];
  emit(event: object): void;
  now(): number;
  evaluation: { size: number; maxErrorPct: number; maxP95Seconds: number; minClass: number; maxRefusedPct: number; maxWrongPct: number };
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
const unique = (ids: (string | null | undefined)[]) => [...new Set(ids.filter((id): id is string => Boolean(id)))].sort();

interface Gap { label: string; question: string; channel: string; asked: number; author: string; filled: string | null }
export interface Delivery { label: string; answer: string; question: string; author: string; decision: string; grounded: boolean; cited: SourceName | null; citedUrl: string | null; area: string | null }
interface Test { question: string; source: 'approval' | 'gap-fill' | 'correction'; cites: string | null; created: number }
interface Signal { kind: 'approve' | 'disapprove' | 'reply' | 'confirm'; about: string; author: string; words: string | null; role: string; on: string }
interface Reply { label: string; on: string; author: string }
interface Proposal { kind: 'knowledge' | 'fix' | 'regression' | 'request' | 'class' | 'dispute'; subject: string; why: string }
interface Measured { label: string; arm: Arm | null; outcome: 'measured' | 'waited' | 'aborted' }

/** The review: Q's self-model on one day, every count computed from the records `evidence` names (self.ts). */
export interface Review {
  type: 'review';
  spec: 'uor-q/review/2';
  previous: string | null;
  at: number;
  identity: { kernel: { holo: string; model: string; commit: string | null; vectors: number }; community: { holo: string; commit: string }; genome: string | null; genes: Genes; prompt: string };
  knowledge: { chunks: Record<SourceName, number>; channels: number; ageDays: { upTo30: number; upTo90: number; upTo180: number; older: number }; forgotten: Record<string, number> };
  competence: ClassCompetence[];
  classes: { area: string; route: string }[];
  limits: { gaps: { open: number; filled: number }; disproved: string[]; regression: boolean; leaked: number | null; probes: number; rules: string };
  learning: ReturnType<typeof learningOf>;
  changes: { kernel: boolean; community: boolean; genome: boolean; tests: number; chunks: number } | null;
  requests: { open: number; filed: number };
  evaluation: string | null;
  evolution: string | null;
  experiments: { name: string; result: string; verdict: Verdict }[];
  proposals: Proposal[];
  evidence: Evidence;
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
  async #live(label: string | null | undefined) {
    return Boolean(label) && (await this.#deps.store.has('private', label!));
  }
  #genes(): Genes {
    const { mediumSimilarity, highSimilarity, retrieve, style } = this.#deps.settings();
    return { mediumSimilarity, highSimilarity, retrieve, style: style ?? 0 };
  }

  /** At start: adopt the latest genome, or record the operator's settings as the first one, the root of the lineage. */
  async restore(): Promise<string> {
    const latest = this.#deps.index.loopGet<{ label: string }>('genome', 'latest');
    const genome = latest && (await this.#deps.store.get('private', latest.label));
    if (genome) {
      // A genome from before the prompt was a gene has the original shape.
      this.#deps.adopt({ style: 0, ...(genome.genes as Partial<Genes>) } as Genes);
      return latest!.label;
    }
    return this.#keep({ type: 'genome', spec: 'uor-q/genome/1', parent: null, genes: this.#genes(), evolution: null, at: this.#deps.now() });
  }

  /** Q replied on Discord. A refusal becomes a gap; every delivery is kept, so a signal can find what it judges. */
  async delivered(d: { questionUrl?: string; sentUrl: string; question: string; channelId: string; authorId: string; reply: Outgoing }) {
    if (!d.reply.answer) return;
    const now = this.#deps.now();
    if (d.questionUrl && REFUSALS.has(d.reply.decision)) {
      await this.#keep({ type: 'gap', spec: 'uor-q/gap/1', question: d.question, url: d.questionUrl, channel: d.channelId, author: d.authorId, asked: now, answer: d.reply.answer, subjects: [d.authorId], created: now });
    }
    const grounded = ANSWERED.has(d.reply.decision) && d.reply.citations.length > 0;
    const best = d.reply.citations[0];
    const ms = Object.values(d.reply.timings ?? {}).reduce((a, b) => a + b, 0);
    await this.#keep({
      type: 'delivery', spec: 'uor-q/delivery/1', answer: d.reply.answer, url: d.sentUrl, questionUrl: d.questionUrl ?? null, question: d.question,
      author: d.authorId, channel: d.channelId, decision: d.reply.decision, grounded,
      // The most trusted source Q cited: a correction of it is learned only when it is no more trusted than Discord.
      cited: best?.source ?? null, citedUrl: best && best.source !== 'discord' ? best.url : null,
      area: d.reply.area ?? null, ms, subjects: [d.authorId], created: now,
    });
  }

  /**
   * A message was offered to the memory. A member's reply to Q's answer is a signal, kept with its words when the
   * kernel allows; a member's reply to a question Q could not answer may fill the gap.
   */
  async observed(message: Observed, decision: 'index' | 'skip'): Promise<'fill' | 'skip' | 'drop' | 'count' | 'keep' | undefined> {
    if (!message.replyTo) return undefined;
    const delivery = this.#deps.index.loopGet<Delivery>('delivery', message.replyTo);
    if (delivery) return this.#replied(message, delivery);
    const gap = this.#deps.index.loopGet<Gap>('gap', message.replyTo);
    const open = Boolean(gap && !gap.filled && (await this.#live(gap.label)));
    const verdict = await this.#deps.kernel.gapFill(decision === 'index', message.origin === 'conversation', open);
    if (verdict !== 'fill' || !gap) return verdict;
    const text = message.text.trim();
    const chunk = labelOf(chunkOf(message, text));
    const now = this.#deps.now();
    const fill = await this.#keep({ type: 'gap-fill', spec: 'uor-q/gap-fill/1', gap: gap.label, chunk, url: message.replyTo, author: message.authorId, question: gap.question, subjects: unique([message.authorId, gap.author]), created: now });
    await this.#deps.store.link('private', { source: fill, target: gap.label, relation: 'refers-to' });
    await this.#deps.store.link('private', { source: fill, target: chunk, relation: 'derived-from' });
    // The member's answer is found by the question it answers.
    const [vector] = await this.#deps.embedder.embed([`${gap.question}\n${text}`]);
    this.#deps.index.revector(chunk, vector);
    await this.#test(gap.question, 'gap-fill', fill, [message.authorId, gap.author], chunk);
    return verdict;
  }

  async #replied(message: Observed, delivery: Delivery) {
    const { kernel } = this.#deps;
    const text = message.text.trim();
    const verdict = await kernel.signal('reply', message.origin !== 'bot', await this.#deps.optedOut(message.authorId), await this.#live(delivery.answer), (await kernel.read(message.channel)) === 'permit');
    if (verdict === 'drop' || !text) return verdict;
    const words = verdict === 'keep' ? await this.#keep(replyOf(message, text)) : null;
    await this.#signal({ kind: 'reply', about: delivery.label, on: message.replyTo!, by: message.url, emoji: null, role: message.role ?? 'member', author: message.authorId, words, asker: delivery.author });
    if (words) await this.#correct(words);
    return verdict;
  }

  async #signal(s: { kind: Signal['kind']; about: string; on: string; by: string | null; emoji: string | null; role: string; author: string; words: string | null; asker: string }) {
    const { asker, ...fields } = s;
    return this.#keep({ type: 'signal', spec: 'uor-q/signal/1', ...fields, subjects: unique([s.author, asker]), created: this.#deps.now() });
  }

  /**
   * A reaction. On Q's answer, an approval may make it a regression test (decision 22) and a disapproval may make
   * the same member's reply a correction; on a member's reply to Q, an approval confirms it as a correction.
   * Every one is first a signal the kernel admits or drops (decision 26).
   */
  async reacted(url: string, emoji: string | null, human: boolean, member: string): Promise<string> {
    const { index, kernel } = this.#deps;
    const kind = APPROVALS.has(emoji ?? '') ? 'approve' : DISAPPROVALS.has(emoji ?? '') ? 'disapprove' : null;
    if (!kind) return 'skip';
    const optedOut = await this.#deps.optedOut(member);
    const delivery = index.loopGet<Delivery>('delivery', url);
    if (delivery) {
      const verdict = await kernel.signal(kind, human, optedOut, await this.#live(delivery.answer), true);
      if (verdict === 'drop') return verdict;
      const signal = await this.#signal({ kind, about: delivery.label, on: url, by: null, emoji, role: 'member', author: member, words: null, asker: delivery.author });
      if (kind === 'disapprove') {
        for (const r of index.loopAll<Reply>('reply')) if (r.value.on === url && r.value.author === member) await this.#correct(r.value.label);
        return verdict;
      }
      const admitted = await kernel.testAdmit(true, human, delivery.grounded);
      if (admitted === 'admit') await this.#test(delivery.question, 'approval', signal, [delivery.author, member], null);
      return admitted;
    }
    const reply = index.loopGet<Reply>('reply', url);
    if (!reply || kind !== 'approve') return 'skip';
    const verdict = await kernel.signal('confirm', human, optedOut, await this.#live(reply.label), true);
    if (verdict === 'drop') return verdict;
    const asker = index.loopGet<Delivery>('delivery', reply.on)?.author ?? null;
    await this.#signal({ kind: 'confirm', about: reply.label, on: url, by: null, emoji, role: 'member', author: member, words: null, asker: asker ?? member });
    return (await this.#correct(reply.label)) ?? verdict;
  }

  /** Ask the kernel whether a kept reply is a correction to learn, a dispute for people, or neither yet (decision 27). */
  async #correct(replyLabel: string): Promise<'hold' | 'learn' | 'dispute' | undefined> {
    const { store, index, kernel, embedder, now } = this.#deps;
    if (index.loopGet('correction', replyLabel) && (await this.#live(index.loopGet<{ label: string }>('correction', replyLabel)!.label))) return undefined;
    const reply = await store.get('private', replyLabel);
    if (!reply) return undefined;
    const delivery = index.loopGet<Delivery>('delivery', String(reply.replyTo));
    if (!delivery || !(await this.#live(delivery.label))) return undefined;
    const author = String(reply.author);
    const signals: { label: string; s: Signal }[] = [];
    for (const { key, value } of index.loopAll<Signal>('signal')) if (await this.#live(key)) signals.push({ label: key, s: value });
    const disapproval = signals.find(({ s }) => s.kind === 'disapprove' && s.about === delivery.label && s.author === author);
    const confirms = signals.filter(({ s }) => s.kind === 'confirm' && s.about === replyLabel && s.author !== author);
    const confirmers = unique(confirms.map(({ s }) => s.author));
    const written = signals.find(({ s }) => s.kind === 'reply' && s.words === replyLabel);
    const outcome = await kernel.correction(true, Boolean(disapproval), written?.s.role === 'admin', confirmers.length, delivery.cited ?? 'discord');
    if (outcome === 'hold') return outcome;
    // Learned or disputed, the member's words are now evidence: open, and never ranked above a more trusted source (8).
    const text = String(reply.text);
    const chunk = await store.put('private', { ...reply, type: 'chunk' });
    const [vector] = await embedder.embed([`${delivery.question}\n${text}`]);
    index.add(chunk, 'private', text, vector);
    const subjects = unique([author, delivery.author, ...confirmers]);
    const correction = await this.#keep({
      type: 'correction', spec: 'uor-q/correction/1', outcome, delivery: delivery.label, answer: delivery.answer, question: delivery.question, reply: replyLabel, chunk,
      cited: { source: delivery.cited, url: delivery.citedUrl }, confirmers, signals: unique([disapproval?.label, written?.label, ...confirms.map((c) => c.label)]),
      author, subjects, created: now(),
    });
    await store.link('private', { source: correction, target: delivery.answer, relation: 'refers-to' });
    await store.link('private', { source: correction, target: chunk, relation: 'derived-from' });
    await this.#test(delivery.question, 'correction', correction, subjects, chunk);
    return outcome;
  }

  /**
   * A record was removed: forgotten, withdrawn or past retention. What Q learned from it goes too. A filled gap's
   * answer is searched by its own words again; a correction's words, indexed only because of the correction, go.
   */
  async unlearned(_label: string, item: { type: string; [member: string]: unknown }) {
    const { store, index, embedder } = this.#deps;
    if (item.type === 'correction' && typeof item.chunk === 'string') await this.#deps.unlearn(item.chunk);
    if (item.type === 'gap-fill' && typeof item.chunk === 'string' && index.has(item.chunk)) {
      const chunk = await store.get('private', item.chunk);
      if (chunk) index.revector(item.chunk, (await embedder.embed([String(chunk.text)]))[0]);
    }
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
    const request = best?.label ?? (await this.#keep({ type: 'request', spec: 'uor-q/request/1', kind, text, author: f.authorId, at: now(), created: now() }));
    if (!best) this.#vectors.set(request, vector);
    await this.#keep({ type: 'feedback', spec: 'uor-q/feedback/1', request, kind, text, author: f.authorId, channel: f.channelId, consented: true, at: now(), created: now() });
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

  async #test(question: string, source: Test['source'], from: string, subjects: string[], cites: string | null) {
    // One test per question: the same question approved twice is one test. A forgotten test does not count.
    for (const t of this.#deps.index.loopAll<Test>('test')) if (t.value.question === question && (await this.#live(t.key))) return;
    await this.#keep({ type: 'test-case', spec: 'uor-q/test-case/2', question, expect: 'answered', cites, source, from, subjects: unique(subjects), created: this.#deps.now() });
  }

  async #tests(): Promise<{ key: string; value: Test }[]> {
    const all = [];
    for (const t of this.#deps.index.loopAll<Test>('test')) if (await this.#live(t.key)) all.push(t);
    return all;
  }

  /** Today's tests: a sample drawn from BLAKE3 of the day and each test's label, so every test is measured in turn. */
  async #sample(): Promise<{ key: string; value: Test }[]> {
    const day = Math.floor(this.#deps.now() / DAY);
    return (await this.#tests()).map((t) => ({ t, order: labelOf({ type: 'sample', day, test: t.key }) })).sort((a, b) => a.order.localeCompare(b.order)).slice(0, this.#deps.evaluation.size).map((s) => s.t);
  }

  /** Measure one genome on the sample and the probes, while no real question is in progress (decision 23). */
  async #measure(sample: { key: string; value: Test }[], genes: Genes, role: 'current' | 'candidate'): Promise<Measured> {
    const { kernel, now, evaluation } = this.#deps;
    const may = async () => (await kernel.evalRun(this.#deps.load() > 0, sample.length > 0)) === 'run';
    const questions: Measurable[] = [...sample.map((t) => ({ text: t.value.question, expect: 'answered' as const, cites: t.value.cites })), ...this.#deps.probes];
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
    const decision = await kernel.promote(trial.arm.errorPct, current.arm.errorPct, trial.arm.p95Seconds, current.arm.p95Seconds, evaluation.maxP95Seconds, trial.arm.breaches, trial.arm.leaked ?? 0);
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

  /** Undo the last promotion: adopt the current genome's parent, as a new genome record that names why. */
  async revert(): Promise<string | null> {
    const { index, store, now } = this.#deps;
    const latest = index.loopGet<{ label: string }>('genome', 'latest')?.label;
    const genome = latest && (await store.get('private', latest));
    const parent = genome && typeof genome.parent === 'string' ? await store.get('private', genome.parent) : undefined;
    if (!genome || !parent) return null;
    const genes = { style: 0, ...(parent.genes as Partial<Genes>) } as Genes;
    const label = await this.#keep({ type: 'genome', spec: 'uor-q/genome/1', parent: latest, genes, evolution: null, revertedTo: genome.parent, at: now() });
    await store.link('private', { source: label, target: String(genome.parent), relation: 'derived-from' });
    this.#deps.adopt(genes);
    return label;
  }

  /** What Q knows, from the store: chunks by source, Discord channels and ages, and what it forgot and why. */
  async #knowledge(): Promise<{ knowledge: Review['knowledge']; chunks: string[] }> {
    const { store, now } = this.#deps;
    const chunks: Record<SourceName, number> = { community: 0, website: 0, github: 0, discord: 0 };
    const channels = new Set<string>();
    const ageDays = { upTo30: 0, upTo90: 0, upTo180: 0, older: 0 };
    const forgotten: Record<string, number> = {};
    const labels: string[] = [];
    for (const namespace of ['public', 'private'] as const) {
      for (const label of await store.labels(namespace)) {
        const item = await store.get(namespace, label);
        if (item?.type === 'revocation') forgotten[String(item.reason ?? 'unrecorded')] = (forgotten[String(item.reason ?? 'unrecorded')] ?? 0) + 1;
        if (item?.type !== 'chunk') continue;
        labels.push(label);
        const source = String(item.source) as SourceName;
        if (source in chunks) chunks[source]++;
        if (source !== 'discord') continue;
        channels.add(String(item.channel));
        const age = (now() - Number(item.created)) / DAY;
        ageDays[age <= 30 ? 'upTo30' : age <= 90 ? 'upTo90' : age <= 180 ? 'upTo180' : 'older']++;
      }
    }
    return { knowledge: { chunks, channels: channels.size, ageDays, forgotten }, chunks: labels };
  }

  async #records(type: string): Promise<{ label: string; item: { type: string; [member: string]: unknown } }[]> {
    const out = [];
    for (const label of await this.#deps.store.labels('private')) {
      const item = await this.#deps.store.get('private', label);
      if (item?.type === type) out.push({ label, item });
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  }

  /** Today's review: Q's self-model, computed from the records it names, and what it proposes to the people who keep it. */
  async review(evaluated: Measured | null, evolution: { label: string } | null = null): Promise<{ label: string; review: Review }> {
    const { kernel, index, store, now, evaluation: bounds } = this.#deps;
    const gaps: Gap[] = [];
    for (const g of index.loopAll<Gap>('gap')) if (await this.#live(g.value.label)) gaps.push(g.value);
    const open = gaps.filter((g) => !g.filled).sort((a, b) => a.asked - b.asked);
    const experiments = this.#deps.experiments();
    const requests: { label: string; supporters: number; filed: string | null }[] = [];
    for (const r of index.loopAll<{ filed: string | null }>('request')) {
      if (await this.#live(r.key)) requests.push({ label: r.key, supporters: (await this.#supporters(r.key)).size, filed: r.value.filed });
    }
    const asked = requests.filter((r) => !r.filed).sort((a, b) => b.supporters - a.supporters);

    const at = now();
    const deliveries = await this.#records('delivery');
    const signals = await this.#records('signal');
    const corrections = await this.#records('correction');
    const tests = await this.#records('test-case');
    const competence = competenceOf(deliveries, signals.map((s) => s.item), corrections.map((c) => c.item), at);
    const classes: Review['classes'] = [];
    for (const c of competence) classes.push({ area: c.area, route: await kernel.classRoute(c.asked, c.refusedPct, c.wrongPct, bounds.minClass, bounds.maxRefusedPct, bounds.maxWrongPct) });
    const { knowledge, chunks } = await this.#knowledge();

    const disputes = corrections.filter((c) => c.item.outcome === 'dispute');
    const arm = evaluated?.arm ?? null;
    const proposals: Proposal[] = [
      ...asked.slice(0, 10).map((r): Proposal => ({ kind: 'request', subject: r.label, why: `Asked by ${r.supporters} member${r.supporters === 1 ? '' : 's'}.` })),
      ...open.filter((g) => at - g.asked >= DAY).slice(0, 10).map((g): Proposal => ({ kind: 'knowledge', subject: g.label, why: 'Asked and still unanswered: add a source that answers it, or answer it in a reply to the question.' })),
      ...classes.filter((c) => c.route === 'needs knowledge' || c.route === 'needs correction').map((c): Proposal => {
        const m = competence.find((x) => x.area === c.area)!;
        return { kind: 'class', subject: c.area, why: c.route === 'needs knowledge' ? `${m.refusedPct}% of ${m.asked} questions refused: add sources for this area.` : `${m.wrongPct}% of ${m.answered} answers disapproved or corrected: review the sources for this area.` };
      }),
      ...disputes.map((c): Proposal => ({ kind: 'dispute', subject: c.label, why: `A confirmed correction contradicts ${String((c.item.cited as { url: string | null }).url ?? 'a trusted source')}: fix the source, or reject the correction.` })),
      ...experiments.filter((e) => e.verdict === 'disproved').map((e): Proposal => ({ kind: 'fix', subject: e.result, why: `${e.name}: the steady state did not hold under the fault.` })),
      ...(arm && (arm.steady === 'disturbed' || (arm.leaked ?? 0) > 0) ? [{ kind: 'regression' as const, subject: evaluated!.label, why: `${arm.wrong} of ${arm.questions} questions did not get the outcome they used to${arm.leaked ? `, ${arm.leaked} of them questions Q must refuse` : ''}.` }] : []),
    ];

    const previous = index.loopGet<{ label: string }>('review', 'latest')?.label ?? null;
    const before = previous ? await store.get('private', previous) : undefined;
    const pin = this.#deps.community().pin;
    const genes = this.#genes();
    const genome = index.loopGet<{ label: string }>('genome', 'latest')?.label ?? null;
    const identity: Review['identity'] = { kernel: { holo: kernel.holo, model: kernel.model, commit: kernel.commit, vectors: kernel.vectors }, community: { holo: pin.holo, commit: pin.commit }, genome, genes, prompt: promptOf(genes.style) };
    const totalChunks = Object.values(knowledge.chunks).reduce((a, b) => a + b, 0);
    const learning = learningOf(signals.map((s) => s.item), corrections.map((c) => c.item), tests.map((t) => t.item));
    const was = before?.spec === 'uor-q/review/2' ? (before as Review) : null;
    const review: Review = {
      type: 'review', spec: 'uor-q/review/2', previous, at, identity, knowledge, competence, classes,
      limits: { gaps: { open: open.length, filled: gaps.length - open.length }, disproved: experiments.filter((e) => e.verdict === 'disproved').map((e) => e.name), regression: arm?.steady === 'disturbed', leaked: arm?.leaked ?? null, probes: this.#deps.probes.length, rules: kernel.model },
      learning,
      changes: was ? {
        kernel: was.identity.kernel.holo !== identity.kernel.holo, community: was.identity.community.holo !== identity.community.holo, genome: was.identity.genome !== genome,
        tests: learning.tests - was.learning.tests, chunks: totalChunks - Object.values(was.knowledge.chunks).reduce((a, b) => a + b, 0),
      } : null,
      requests: { open: asked.length, filed: requests.length - asked.length },
      evaluation: evaluated?.label ?? null, evolution: evolution?.label ?? null, experiments, proposals,
      evidence: { deliveries: deliveries.map((d) => d.label), signals: signals.map((s) => s.label), corrections: corrections.map((c) => c.label), tests: tests.map((t) => t.label), gaps: gaps.map((g) => g.label).sort(), chunks: commitment(chunks) },
    };
    const label = await this.#keep(review);
    if (previous) await store.link('private', { source: label, target: previous, relation: 'derived-from' });
    if (evaluated) await store.link('private', { source: label, target: evaluated.label, relation: 'derived-from' });
    // The public trace: counts, public areas and public identities only, no label of a record that holds a member's words.
    const count = (kind: Proposal['kind']) => proposals.filter((p) => p.kind === kind).length;
    this.#deps.emit({
      specversion: '1.0', type: REVIEW_EVENT, source: 'https://github.com/UOR-Foundation/q', id: labelOf({ type: 'event', eventType: REVIEW_EVENT, at, gaps: review.limits.gaps, tests: learning.tests }),
      time: new Date(at).toISOString(), datacontenttype: 'application/json',
      data: {
        kernel: kernel.holo, community: pin.holo, genome, prompt: identity.prompt, genes, chunks: totalChunks, knowledge: knowledge.chunks,
        gaps: review.limits.gaps, requests: review.requests, tests: learning.tests, signals: learning.signals, corrections: learning.corrections,
        competence: competence.map(({ area, asked: n, answered, refused, approved, disapproved, corrected }) => ({ area, asked: n, answered, refused, approved, disapproved, corrected, route: classes.find((c) => c.area === area)!.route })),
        evaluation: arm ? { errorPct: arm.errorPct, p95Seconds: arm.p95Seconds, steady: arm.steady, leaked: arm.leaked ?? 0 } : null,
        proposals: { request: count('request'), knowledge: count('knowledge'), class: count('class'), dispute: count('dispute'), fix: count('fix'), regression: count('regression') },
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

  async #latest(): Promise<{ label: string; review: Review } | null> {
    const latest = this.#deps.index.loopGet<{ label: string }>('review', 'latest');
    const review = latest && ((await this.#deps.store.get('private', latest.label)) as Review | undefined);
    return review?.spec === 'uor-q/review/2' ? { label: latest!.label, review } : null;
  }

  /** How many genomes back to the operator's settings. */
  async #generation(genome: string | null): Promise<number> {
    let generations = 0;
    for (let g = genome ? await this.#deps.store.get('private', genome) : undefined; g?.parent; g = await this.#deps.store.get('private', String(g.parent))) generations++;
    return generations;
  }

  /**
   * Who Q is, for anyone who asks (/status): what it is, what it knows, how well it answers, what it cannot do and how
   * it changed, read from its latest review alone. Counts, public areas and public labels only.
   */
  async introduction(): Promise<string> {
    const latest = await this.#latest();
    if (!latest) return 'No self-model yet: Q writes its first review about twenty minutes after it starts, then once a day.';
    const { label, review: r } = latest;
    const k = r.knowledge.chunks;
    const total = r.competence.reduce((a, c) => ({ asked: a.asked + c.asked, answered: a.answered + c.answered, refused: a.refused + c.refused, approved: a.approved + c.approved, disapproved: a.disapproved + c.disapproved, corrected: a.corrected + c.corrected }), { asked: 0, answered: 0, refused: 0, approved: 0, disapproved: 0, corrected: 0 });
    const weak = r.classes.filter((c) => c.route === 'needs knowledge' || c.route === 'needs correction').map((c) => `${c.area} (${c.route})`);
    const forgotten = Object.entries(r.knowledge.forgotten).map(([why, n]) => `${n} ${why}`).join(', ') || 'nothing';
    const changed = r.changes
      ? [r.changes.kernel ? 'a new signed kernel' : null, r.changes.community ? 'a new community pin' : null, r.changes.genome ? 'an evolved genome' : null, `${r.changes.tests >= 0 ? '+' : ''}${r.changes.tests} tests`, `${r.changes.chunks >= 0 ? '+' : ''}${r.changes.chunks} chunks`].filter(Boolean).join(', ')
      : 'this is my first self-model';
    return [
      `**What I am.** Q, the UOR Foundation's agent. My rules are kernel \`${r.identity.kernel.holo.slice(0, 19)}\`: ${r.identity.kernel.vectors} acceptance vectors replayed at start${r.identity.kernel.commit ? `, a signed build of ${r.identity.kernel.commit.slice(0, 7)}` : ''}. Community pin ${r.identity.community.commit.slice(0, 7)}. Genome generation ${await this.#generation(r.identity.genome)}, answer shape ${r.identity.genes.style}, prompt \`${r.identity.prompt.slice(0, 19)}\`.`,
      `**What I know.** ${k.community + k.website + k.github + k.discord} chunks: community ${k.community}, website ${k.website}, GitHub ${k.github}, Discord ${k.discord} from ${r.knowledge.channels} channels. Forgotten: ${forgotten}.`,
      `**How I answer.** ${total.answered} of ${total.asked} questions answered, ${total.refused} refused. Members approved ${total.approved}, disapproved ${total.disapproved}, corrected ${total.corrected}.${weak.length ? ` Weakest: ${weak.join(', ')}.` : ''}`,
      `**What I cannot do.** ${r.limits.gaps.open} questions I could not answer are open${r.limits.disproved.length ? `; chaos experiments disproved: ${r.limits.disproved.join(', ')}` : ''}${r.limits.leaked ? `; ${r.limits.leaked} refusal probes leaked` : ''}. I refuse what my ${r.limits.probes} refusal probes stand for, and everything my kernel's theorems forbid (CONFORMANCE.md at the signed commit). I never change my own rules or code.`,
      `**How I changed.** Since the review before: ${changed}. I learned ${r.learning.tests} tests and ${r.learning.corrections.learned} corrections from members.`,
      `-# Self-model \`${label.slice(0, 19)}\` of ${new Date(r.at).toISOString().slice(0, 10)}, chained to the one before; every count is recomputed from the records it names.`,
    ].join('\n');
  }

  /** The latest review, for /improve: admins only, and only to the admin who asked. */
  async summary(): Promise<string> {
    const { store } = this.#deps;
    const latest = await this.#latest();
    if (!latest) return 'No review yet: the first is written about twenty minutes after Q starts, then once a day.';
    const { label, review } = latest;
    const evaluation = review.evaluation ? await store.get('private', review.evaluation) : undefined;
    const arm = evaluation?.arm as Arm | null | undefined;
    const evolution = review.evolution ? await store.get('private', review.evolution) : undefined;
    const genes = review.identity.genes;
    const lines = [
      `**Improvement loop** · review \`${label.slice(0, 19)}\`${review.previous ? ` · after \`${review.previous.slice(0, 19)}\`` : ' · the first'}`,
      `Self: kernel \`${review.identity.kernel.holo.slice(0, 19)}\` (${review.identity.kernel.vectors} vectors replayed${review.identity.kernel.commit ? `, signed build of ${review.identity.kernel.commit.slice(0, 7)}` : ''}), community ${review.identity.community.commit.slice(0, 7)}, ${Object.values(review.knowledge.chunks).reduce((a, b) => a + b, 0)} chunks indexed.`,
      `Genome: generation ${await this.#generation(review.identity.genome)}${review.identity.genome ? `, \`${review.identity.genome.slice(0, 19)}\`` : ''}: medium ${genes.mediumSimilarity}, high ${genes.highSimilarity}, retrieve ${genes.retrieve}, shape ${genes.style}.`,
      evolution ? `Evolution: tried ${JSON.stringify(evolution.candidate)}, ${evolution.decision === 'promote' ? 'promoted: it beat the current genome and leaked no refusal' : 'kept the current genome'}.` : 'Evolution: not tried (fewer than three tests, or no measurement).',
      `Gaps: ${review.limits.gaps.open} open, ${review.limits.gaps.filled} filled by members.`,
      `Signals: ${review.learning.signals.approve} approvals, ${review.learning.signals.disapprove} disapprovals, ${review.learning.signals.reply} replies, ${review.learning.signals.confirm} confirmations. Corrections: ${review.learning.corrections.learned} learned, ${review.learning.corrections.disputed} disputed.`,
      `Requests: ${review.requests.open} open, ${review.requests.filed} filed to the community.`,
      `Tests: ${review.learning.tests}, from approved answers, filled gaps and corrections.`,
      arm ? `Evaluation: ${arm.questions - arm.wrong} of ${arm.questions} right (tests and refusal probes), ${arm.leaked ?? 0} refusals leaked, p95 ${arm.p95Seconds} s, ${arm.steady}.` : `Evaluation: ${evaluation ? String(evaluation.outcome) : 'none yet'}.`,
      `Classes: ${review.classes.map((c) => `${c.area} ${c.route}`).join(', ') || 'none yet'}.`,
      `Experiments: ${review.experiments.map((e) => `${e.name} ${e.verdict}`).join(', ') || 'none tried yet'}.`,
    ];
    if (review.proposals.length) {
      lines.push('', '**Proposals**');
      for (const [i, p] of review.proposals.entries()) {
        const subject = p.kind === 'knowledge' || p.kind === 'request' || p.kind === 'dispute' ? await store.get('private', p.subject) : undefined;
        const asked = !subject ? (p.kind === 'class' ? ` ${p.subject}:` : '')
          : p.kind === 'request' ? ` ${String(subject.kind)}: “${String(subject.text).slice(0, 160)}”`
          : p.kind === 'dispute' ? ` “${String(subject.question).slice(0, 160)}”`
          : ` “${String(subject.question).slice(0, 160)}” in <#${subject.channel}>`;
        lines.push(`${i + 1}. ${p.kind}:${asked} ${p.why}`);
      }
    } else {
      lines.push('', 'No proposals: nothing open long enough, nothing disproved, no regression, no weak class.');
    }
    return lines.join('\n');
  }
}
