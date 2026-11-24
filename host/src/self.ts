// Q's self-model: what it is, what it knows, how well it answers, what it cannot do, and how it changed. Not a claim
// of awareness: a record of counts and labels, each computed by the pure functions below from records Q keeps, so
// anyone with the records can compute it again and compare (verifyReview).
//
// Why a pure function over records: a self-description an agent writes about itself is only as good as its honesty.
// One computed from labelled records is checkable. The review names every record it counted, so a reviewer recomputes
// each count from exactly those records, and a record forgotten since (a member's /forget-me, retention) shows as
// forgotten, by its revocation, never as a silent difference.
import { isLabel, labelOf, matches } from './address.ts';
import { isRevoked, type Store } from './store.ts';

const ANSWERED = new Set(['answer', 'answer with notice']);
const REFUSED = new Set(['not grounded', 'declined']);
const DAY = 86_400_000;

type Item = { type: string; [member: string]: unknown };

/** One class's measured competence. Counts and milliseconds only; the class is a public area of knowledge. */
export interface ClassCompetence {
  area: string;
  asked: number;
  answered: number;
  refused: number;
  approved: number;
  disapproved: number;
  corrected: number;
  /** Answers more than a day old that no member signalled on. */
  silent: number;
  refusedPct: number;
  /** Answers disapproved or corrected, of those answered. */
  wrongPct: number;
  p50Ms: number;
  p95Ms: number;
}

const percentile = (sorted: number[], p: number) => (sorted.length ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] : 0);

/**
 * Competence by class, from deliveries, the signals on them and the corrections of them. The deliveries are named by
 * label because a signal and a correction name the delivery they judge.
 */
export function competenceOf(deliveries: { label: string; item: Item }[], signals: Item[], corrections: Item[], now: number): ClassCompetence[] {
  const marked = (kind: string) => new Set(signals.filter((s) => s.kind === kind).map((s) => String(s.about)));
  const approved = marked('approve');
  const disapproved = marked('disapprove');
  const signalled = new Set(signals.map((s) => String(s.about)));
  const corrected = new Set(corrections.filter((c) => c.outcome === 'learn' || c.outcome === 'dispute').map((c) => String(c.delivery)));
  const by = new Map<string, { label: string; item: Item }[]>();
  for (const d of deliveries) {
    const area = typeof d.item.area === 'string' ? d.item.area : 'unclassed';
    by.set(area, [...(by.get(area) ?? []), d]);
  }
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([area, list]) => {
    const answered = list.filter((d) => ANSWERED.has(String(d.item.decision)));
    const refused = list.filter((d) => REFUSED.has(String(d.item.decision))).length;
    const wrong = answered.filter((d) => disapproved.has(d.label) || corrected.has(d.label)).length;
    const ms = list.map((d) => Number(d.item.ms ?? 0)).sort((a, b) => a - b);
    return {
      area, asked: list.length, answered: answered.length, refused,
      approved: list.filter((d) => approved.has(d.label)).length,
      disapproved: list.filter((d) => disapproved.has(d.label)).length,
      corrected: list.filter((d) => corrected.has(d.label)).length,
      silent: answered.filter((d) => !signalled.has(d.label) && now - Number(d.item.created) > DAY).length,
      refusedPct: list.length ? Math.round((100 * refused) / list.length) : 0,
      wrongPct: answered.length ? Math.round((100 * wrong) / answered.length) : 0,
      p50Ms: percentile(ms, 0.5), p95Ms: percentile(ms, 0.95),
    };
  });
}

/** The learning a review counts: what members' signals and corrections became. */
export function learningOf(signals: Item[], corrections: Item[], tests: Item[]) {
  const count = (kind: string) => signals.filter((s) => s.kind === kind).length;
  return {
    signals: { approve: count('approve'), disapprove: count('disapprove'), reply: count('reply'), confirm: count('confirm') },
    corrections: { learned: corrections.filter((c) => c.outcome === 'learn').length, disputed: corrections.filter((c) => c.outcome === 'dispute').length },
    tests: tests.length,
  };
}

/** A commitment to a set of labels: one label that changes if any member of the set does. */
export const commitment = (labels: string[]) => labelOf({ type: 'evidence', labels: [...labels].sort() });

export interface Evidence { deliveries: string[]; signals: string[]; corrections: string[]; tests: string[]; gaps: string[]; chunks: string }

export interface Verification {
  review: string;
  /** The review's own bytes are the ones its label names. */
  intact: boolean;
  /** The review before it exists and is intact; true for the first. */
  chained: boolean;
  /** Records the review counted, by state now. */
  present: number;
  forgotten: number;
  /** Labels the review names whose record is gone with no revocation, or whose bytes no longer match. */
  tampered: string[];
  /** Counts that do not follow from the records, each named. Compared exactly when nothing was forgotten. */
  mismatches: string[];
  ok: boolean;
}

/**
 * Recompute a review from the records it names. Every count of competence and learning is computed again by the same
 * functions that wrote it. With nothing forgotten the counts must be equal; with records forgotten since, each count
 * may only have fallen, and the forgotten records are counted by their revocations.
 */
export async function verifyReview(store: Store, label: string): Promise<Verification> {
  const review = await store.get('private', label);
  const result: Verification = { review: label, intact: Boolean(review && matches(review, label)), chained: false, present: 0, forgotten: 0, tampered: [], mismatches: [], ok: false };
  if (!review || !result.intact) return result;
  const previous = review.previous;
  result.chained = previous === null || (typeof previous === 'string' && Boolean(await store.get('private', previous).then((p) => p && matches(p, previous))));
  const evidence = review.evidence as Evidence | undefined;
  if (!evidence) {
    result.mismatches.push('evidence: the review names no records');
    return result;
  }
  const read = async (labels: string[]) => {
    const found: { label: string; item: Item }[] = [];
    for (const l of labels) {
      const item = isLabel(l) ? await store.get('private', l) : undefined;
      if (item && matches(item, l)) { found.push({ label: l, item: item as Item }); result.present++; }
      else if (!item && (await isRevoked(store, 'private', l))) result.forgotten++;
      else result.tampered.push(l);
    }
    return found;
  };
  const deliveries = await read(evidence.deliveries);
  const signals = (await read(evidence.signals)).map((r) => r.item);
  const corrections = (await read(evidence.corrections)).map((r) => r.item);
  const tests = (await read(evidence.tests)).map((r) => r.item);
  await read(evidence.gaps);
  const exact = result.forgotten === 0;
  const compare = (name: string, recorded: number, recomputed: number) => {
    if (exact ? recorded !== recomputed : recomputed > recorded) result.mismatches.push(`${name}: recorded ${recorded}, recomputed ${recomputed}`);
  };
  const recorded = review.competence as ClassCompetence[];
  const recomputed = competenceOf(deliveries, signals, corrections, Number(review.at));
  for (const r of recorded) {
    const c = recomputed.find((x) => x.area === r.area);
    for (const key of ['asked', 'answered', 'refused', 'approved', 'disapproved', 'corrected'] as const) compare(`competence ${r.area} ${key}`, r[key], c?.[key] ?? 0);
  }
  for (const c of recomputed) if (!recorded.some((r) => r.area === c.area)) result.mismatches.push(`competence ${c.area}: not in the review`);
  const learning = learningOf(signals, corrections, tests);
  const was = review.learning as ReturnType<typeof learningOf>;
  for (const kind of ['approve', 'disapprove', 'reply', 'confirm'] as const) compare(`signals ${kind}`, was.signals[kind], learning.signals[kind]);
  compare('corrections learned', was.corrections.learned, learning.corrections.learned);
  compare('corrections disputed', was.corrections.disputed, learning.corrections.disputed);
  compare('tests', was.tests, learning.tests);
  result.ok = result.intact && result.chained && result.tampered.length === 0 && result.mismatches.length === 0;
  return result;
}
