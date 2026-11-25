// Bounded advisory task graph, adapted from Skillz Effort Allocation Navigator
// v0.3.0 (MIT), upstream 887d14b49194f1a6dd1231c6d1be896003122dc7.
// This is a limited host-side adaptation, not package equivalence or policy.
// Input claims (including readiness, priorities and completion) must be
// reconciled by an authorized caller. No network, writes or autonomous work.
export type Task = {
  id: string;
  kind: 'action' | 'milestone';
  state: 'todo' | 'doing' | 'done' | 'unknown';
  eligibility: 'ready' | 'blocked' | 'unknown';
  dependsOn: readonly string[];
  obligation: 'safety' | 'confirmed-imminent' | 'discretionary';
  // Null is unknown, not zero. Values are explicitly provisional estimates.
  effortMinutes: number | null;
  value: number | null;
};
export type TaskSnapshot = {
  tasks: readonly Task[];
  coverage: 'complete' | 'partial' | 'unknown';
  selectedFocus?: string;
  capacityMinutes?: number;
};
type Lane = 'safety' | 'confirmed-imminent' | 'discretionary';
type Choice = {
  taskId: string;
  action: 'begin' | 'estimate' | 'decompose' | 'verify';
  lane: Lane;
  immediateUnlocks: number;
  downstream: number;
  firstSliceMinutes: number;
  defersProtectedWork: boolean;
};
type Result = {
  state: 'advisory';
  basis: 'caller-assertions-not-independent-proof';
  coverage: TaskSnapshot['coverage'];
  choices: Choice[];
  blocked: string[];
  protectedUnresolved: string[];
  unscored: string[];
  needsDecomposition: string[];
  needsVerification: string[];
  mode: 'begin' | 'estimate' | 'decompose' | 'verify' | 'blocked' | 'no-open-work-in-snapshot';
} | { state: 'invalid'; reason: 'invalid-snapshot' | 'duplicate-id' | 'missing-dependency' | 'cycle' | 'contradictory-completion' };

const ID = /^[a-z][a-z0-9-]{1,99}$/;
const MAX_TASKS = 200;
const bounded = (n: unknown, lo: number, hi: number): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= lo && n <= hi;
const lanes: readonly Lane[] = ['safety', 'confirmed-imminent', 'discretionary'];
const invalid = (reason: Extract<Result, {state: 'invalid'}>['reason']): Result => ({state: 'invalid', reason});

export function recommendWork(snapshot: TaskSnapshot): Result {
  if (!snapshot || !Array.isArray(snapshot.tasks) || snapshot.tasks.length > MAX_TASKS ||
      !['complete','partial','unknown'].includes(snapshot.coverage) ||
      (snapshot.capacityMinutes !== undefined && !bounded(snapshot.capacityMinutes, 1, 10080)) ||
      (snapshot.selectedFocus !== undefined && (typeof snapshot.selectedFocus !== 'string' || !ID.test(snapshot.selectedFocus)))) {
    return invalid('invalid-snapshot');
  }
  const tasks = new Map<string, Task>();
  for (const task of snapshot.tasks) {
    if (!task || typeof task.id !== 'string' || !ID.test(task.id) ||
        !['action','milestone'].includes(task.kind) ||
        !['todo','doing','done','unknown'].includes(task.state) ||
        !['ready','blocked','unknown'].includes(task.eligibility) ||
        !lanes.includes(task.obligation) || !Array.isArray(task.dependsOn) ||
        task.dependsOn.length > MAX_TASKS ||
        task.dependsOn.some((d: unknown) => typeof d !== 'string' || !ID.test(d)) ||
        new Set(task.dependsOn).size !== task.dependsOn.length ||
        (task.effortMinutes !== null && !bounded(task.effortMinutes, 1, 10080)) ||
        (task.value !== null && !bounded(task.value, 1, 5)) ||
        (task.kind === 'milestone' && (task.effortMinutes !== null || task.value !== null))) return invalid('invalid-snapshot');
    if (tasks.has(task.id)) return invalid('duplicate-id');
    tasks.set(task.id, task);
  }
  const keys = [...tasks.keys()].sort();
  for (const task of tasks.values()) {
    if (task.dependsOn.some(dep => !tasks.has(dep))) return invalid('missing-dependency');
  }
  const visiting = new Set<string>();
  const ancestors = new Map<string, Set<string>>();
  function visit(id: string): Set<string> {
    if (visiting.has(id)) throw Error('cycle');
    const known = ancestors.get(id);
    if (known) return known;
    visiting.add(id);
    const all = new Set<string>();
    for (const dep of tasks.get(id)!.dependsOn) {
      all.add(dep);
      for (const a of visit(dep)) all.add(a);
    }
    visiting.delete(id);
    ancestors.set(id, all);
    return all;
  }
  try { for (const id of keys) visit(id); } catch { return invalid('cycle'); }
  for (const t of tasks.values()) {
    if (t.state === 'done' && t.dependsOn.some(d => tasks.get(d)!.state !== 'done')) return invalid('contradictory-completion');
  }

  const open = keys.filter(id => tasks.get(id)!.state !== 'done');
  const blocked: string[] = [], unscored: string[] = [], needsDecomposition: string[] = [], needsVerification: string[] = [];
  type Candidate = { id: string; lane: number; action: Choice['action']; score: number | null; immediate: number; downstream: number };
  const candidates: Candidate[] = [];
  const laneOf = (id: string) => Math.min(lanes.indexOf(tasks.get(id)!.obligation),
    ...open.filter(other => ancestors.get(other)!.has(id)).map(other => lanes.indexOf(tasks.get(other)!.obligation)));
  for (const id of open) {
    const t = tasks.get(id)!;
    if (t.state === 'unknown' || t.eligibility !== 'ready' || t.dependsOn.some(dep => tasks.get(dep)!.state !== 'done')) {
      blocked.push(id); continue;
    }
    const descendants = open.filter(other => ancestors.get(other)!.has(id));
    const immediate = descendants.filter(other => {
      const next = tasks.get(other)!;
      return next.state !== 'unknown' && next.eligibility === 'ready' &&
        next.dependsOn.includes(id) && next.dependsOn.every(dep => dep === id || tasks.get(dep)!.state === 'done');
    }).length;
    const common = {id, lane: laneOf(id), immediate, downstream: descendants.length};
    if (t.kind === 'milestone') {
      const action = t.dependsOn.length ? 'verify' : 'decompose';
      (action === 'verify' ? needsVerification : needsDecomposition).push(id);
      candidates.push({...common, action, score: null});
    } else if (t.effortMinutes === null || t.value === null) {
      unscored.push(id);
      candidates.push({...common, action: 'estimate', score: null});
    } else {
      const score = (4 * t.value + 3 * Math.min(3, immediate) +
        Math.min(3, descendants.length) + (t.state === 'doing' ? 2 : 0)) /
        Math.sqrt(1 + t.effortMinutes / 120);
      candidates.push({...common, action: 'begin', score});
    }
  }
  // Protected lanes precede discretionary work. Missing estimates in a
  // protected lane must surface rather than quietly lose to scored work.
  const actionRank = (c: Candidate) => c.lane < 2
    ? (c.action === 'begin' ? 1 : 0) : (c.action === 'begin' ? 0 : 1);
  candidates.sort((a,b) => a.lane-b.lane || actionRank(a)-actionRank(b) ||
    (b.score ?? -1)-(a.score ?? -1) || a.id.localeCompare(b.id));
  const best = candidates[0];
  if (best?.action === 'begin' && snapshot.selectedFocus) {
    const i = candidates.findIndex(c => c.id === snapshot.selectedFocus && c.action === 'begin' &&
      c.lane === best.lane && c.score! >= best.score! * 0.85);
    if (i > 0) candidates.unshift(candidates.splice(i, 1)[0]);
  }
  const primary = candidates[0];
  // Prefer a comparable, distinct immediate-unblock route as the alternative.
  // Never prefer a lower priority lane over a ready higher lane.
  const rest = candidates.slice(1);
  const alternative = rest.find(c => c.lane === rest[0]?.lane && c.lane === primary?.lane &&
    c.action === 'begin' && primary.action === 'begin' && c.score !== null && rest[0].score !== null &&
    c.score >= rest[0].score * 0.7 && (c.immediate > 0) !== (primary.immediate > 0)) ?? rest[0];
  const protectedUnresolved = blocked.filter(id => laneOf(id) < 2);
  const choices = [primary, alternative].filter((c): c is Candidate => c !== undefined).map((c,i): Choice => ({
    taskId: c.id, action: c.action, lane: lanes[c.lane], immediateUnlocks: c.immediate, downstream: c.downstream,
    firstSliceMinutes: Math.min(5, snapshot.capacityMinutes ?? 5, tasks.get(c.id)!.effortMinutes ?? 5),
    defersProtectedWork: (c.lane === 2 && protectedUnresolved.length > 0) || (i > 0 && primary.lane < 2),
  }));
  return {state: 'advisory', basis: 'caller-assertions-not-independent-proof', coverage: snapshot.coverage, choices,
    blocked, protectedUnresolved, unscored, needsDecomposition, needsVerification,
    mode: primary?.action ?? (open.length ? 'blocked' : snapshot.coverage === 'complete' ? 'no-open-work-in-snapshot' : 'blocked')};
}
