// Fresh public repository work observations for Focus. Unlike the architecture
// inventory, the first pass does not fetch repository trees. All reads go
// through the bounded anonymous transport. No writes or permission inference.
import type { PublicRead } from './focus-discovery.ts';
const ORG = 'UOR-Foundation';
const REPO = /^[A-Za-z0-9_.-]{1,100}$/;
const SHA = /^[a-f0-9]{40}$/;
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const number = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const timestamp = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v.replace('Z', '.000Z');
type Coverage = 'complete' | 'partial' | 'unavailable';
export type WorkItem = {
  repository: string; number: number; kind: 'issue' | 'pull';
  url: string; title: string; updatedAt: string; assigned: boolean;
  /** Provider-native labels, not verified priority, readiness or authority. */
  labels: string[] | null;
};
type RepoWork = { repository: string; defaultBranch: string; topics: string[] | null; coverage: Coverage; items: WorkItem[] };
export type LiveWorkSnapshot = {
  startedAt: string; finishedAt: string; coverage: Coverage;
  enumeration: Coverage; repositories: RepoWork[];
  omittedRepositories: number; invalidRecords: number;
};
export type PullObservation =
  | { state: 'unknown'; reason: 'not-observed' | 'unavailable' | 'changed' }
  | { state: 'observed'; repository: string; number: number; head: string; base: string;
      baseRef: string; draft: boolean; mergeable: boolean | null;
      observedAt: string; checks: { coverage: Coverage; runs: { id: number; status: string; conclusion: string | null }[] };
      reviewAndRequiredControls: 'unverified' };

function bound(v: number, max: number): number {
  if (!number(v) || v > max) throw new RangeError('invalid live work budget');
  return v;
}
function repoName(v: unknown): v is string {
  return typeof v === 'string' && REPO.test(v) && v !== '.' && v !== '..';
}
// Native metadata is an optional discovery hint. Unknown differs from empty;
// malformed or oversized input is not silently treated as absence.
function metadata(values: unknown, labelObjects = false): string[] | null {
  if (!Array.isArray(values) || values.length > 100) return null;
  const names: string[] = [];
  for (const value of values) {
    const name = labelObjects && obj(value) ? value.name : value;
    if (typeof name !== 'string' || !name.length || name.length > 100 ||
        /[\x00-\x1f\x7f]/.test(name)) return null;
    names.push(name);
  }
  return [...new Set(names)].sort();
}

function workItem(row: unknown, repo: string): WorkItem | null {
  if (!obj(row) || !number(row.number) || row.state !== 'open' || typeof row.title !== 'string' ||
      !timestamp(row.updated_at) || !Array.isArray(row.assignees) || !row.assignees.every(a => obj(a) && number(a.id))) return null;
  const isPull = Object.hasOwn(row, 'pull_request');
  if (isPull && !obj(row.pull_request)) return null;
  const url = 'https://github.com/' + repo + '/' + (isPull ? 'pull/' : 'issues/') + row.number;
  if (row.html_url !== url || row.repository_url !== 'https://api.github.com/repos/' + repo) return null;
  // Issue titles are untrusted evidence, not instructions. Drop control chars,
  // cap size, and never ingest bodies or user identities in this first pass.
  return { repository: repo, number: row.number, kind: isPull ? 'pull' : 'issue', url,
    title: row.title.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 256), updatedAt: row.updated_at, assigned: row.assignees.length > 0, labels: metadata(row.labels, true) };
}

/** Bounded two-stage scan: enumerate the public active repo scope, then read
 * current open issues (the GitHub issues endpoint also lists open PRs).
 * Pagination exhaustion is not an atomic organization snapshot. Changes
 * during a scan, external dependencies, security issues and readiness
 * remain unknown. A partial scope cannot establish global optimality.
 */
export async function collectLiveWork(read: PublicRead, options: {
  maxOrgPages?: number; maxRepositories?: number; maxWorkPages?: number;
  now?: () => Date;
} = {}): Promise<LiveWorkSnapshot> {
  const maxOrg = bound(options.maxOrgPages ?? 10, 100);
  const maxRepos = bound(options.maxRepositories ?? 100, 200);
  const maxWork = bound(options.maxWorkPages ?? 3, 20);
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const candidates: { repository: string; defaultBranch: string; topics: string[] | null }[] = [];
  const seen = new Set<string>();
  let pages = 0, orgExhausted = false, invalidRecords = 0, omittedRepositories = 0;
  for (let page = 1; page <= maxOrg; page++) {
    let rows: unknown;
    try { rows = await read('/orgs/' + ORG + '/repos?type=public&sort=full_name&direction=asc&per_page=100&page=' + page); }
    catch { break; }
    if (!Array.isArray(rows) || rows.length > 100) break;
    pages++;
    for (const row of rows) {
      if (!obj(row) || !repoName(row.name) || row.full_name !== ORG + '/' + row.name ||
          row.private !== false || row.visibility !== 'public' || typeof row.archived !== 'boolean' ||
          typeof row.fork !== 'boolean' || typeof row.default_branch !== 'string' || !row.default_branch ||
          row.default_branch.length > 255 || /[\x00-\x1f\x7f]/.test(row.default_branch)) { invalidRecords++; continue; }
      const key = row.name.toLowerCase();
      if (seen.has(key)) { invalidRecords++; continue; }
      seen.add(key);
      if (row.archived || row.fork) continue;
      if (candidates.length >= maxRepos) { omittedRepositories++; continue; }
      candidates.push({repository: ORG + '/' + row.name, defaultBranch: row.default_branch, topics: metadata(row.topics)});
    }
    if (rows.length < 100) { orgExhausted = true; break; }
  }
  const enumeration: Coverage = !pages ? 'unavailable' : orgExhausted && !invalidRecords ? 'complete' : 'partial';
  const repositories: RepoWork[] = [];
  for (const candidate of candidates) {
    const items: WorkItem[] = [];
    const seenNumbers = new Set<number>();
    let readPages = 0, exhausted = false, invalid = false;
    for (let page = 1; page <= maxWork; page++) {
      let rows: unknown;
      try { rows = await read('/repos/' + candidate.repository + '/issues?state=open&sort=created&direction=asc&per_page=100&page=' + page); }
      catch { break; }
      if (!Array.isArray(rows) || rows.length > 100) { invalid = true; break; }
      readPages++;
      for (const row of rows) {
        const item = workItem(row, candidate.repository);
        if (!item || seenNumbers.has(item.number)) { invalid = true; invalidRecords++; continue; }
        seenNumbers.add(item.number);
        items.push(item);
      }
      if (rows.length < 100) { exhausted = true; break; }
    }
    repositories.push({...candidate, items, coverage: !readPages ? 'unavailable' : exhausted && !invalid ? 'complete' : 'partial'});
  }
  const coverage: Coverage = enumeration === 'unavailable' ? 'unavailable' :
    enumeration === 'complete' && !omittedRepositories && repositories.every(r => r.coverage === 'complete') ? 'complete' : 'partial';
  return {startedAt, finishedAt: now().toISOString(), coverage, enumeration, repositories, omittedRepositories, invalidRecords};
}

function pullIdentity(raw: unknown, repo: string, n: number) {
  if (!obj(raw) || raw.number !== n || raw.state !== 'open' || raw.html_url !== 'https://github.com/' + repo + '/pull/' + n ||
      !obj(raw.head) || !obj(raw.base) || !obj(raw.base.repo) || raw.base.repo.full_name !== repo ||
      raw.base.repo.private !== false || typeof raw.head.sha !== 'string' || !SHA.test(raw.head.sha) ||
      typeof raw.base.sha !== 'string' || !SHA.test(raw.base.sha) || typeof raw.base.ref !== 'string' ||
      !raw.base.ref || raw.base.ref.length > 255 || /[\x00-\x1f\x7f]/.test(raw.base.ref) ||
      typeof raw.draft !== 'boolean' || (raw.mergeable !== null && typeof raw.mergeable !== 'boolean') || !timestamp(raw.updated_at)) return null;
  return {head: raw.head.sha, base: raw.base.sha, baseRef: raw.base.ref, draft: raw.draft, mergeable: raw.mergeable, updatedAt: raw.updated_at};
}

/** On-demand exact-head check evidence for a previously observed PR.
 * Read the PR again after checks to detect head/base/state drift. Checks
 * are observations only: required contexts/apps, classic statuses, review,
 * merge-group and branch protection are not established by this function.
 */
export async function inspectLivePull(read: PublicRead, snapshot: LiveWorkSnapshot,
  repository: string, n: number, options: {maxCheckPages?: number; now?: () => Date} = {}): Promise<PullObservation> {
  const max = bound(options.maxCheckPages ?? 2, 20);
  const matches = snapshot.repositories.filter(r => r.repository === repository);
  if (!repository.startsWith(ORG + '/') || !repoName(repository.slice(ORG.length + 1)) || !number(n) ||
      matches.length !== 1 || matches[0].items.filter(i => i.repository === repository && i.number === n && i.kind === 'pull').length !== 1)
    return {state: 'unknown', reason: 'not-observed'};
  const path = '/repos/' + repository + '/pulls/' + n;
  let first: ReturnType<typeof pullIdentity>;
  try { first = pullIdentity(await read(path), repository, n); } catch { return {state: 'unknown', reason: 'unavailable'}; }
  if (!first) return {state: 'unknown', reason: 'changed'};
  const runs: {id: number; status: string; conclusion: string | null}[] = [];
  const seen = new Set<number>();
  let pages = 0, exhausted = false, invalid = false, expected: number | null = null;
  for (let page = 1; page <= max; page++) {
    let raw: unknown;
    try { raw = await read('/repos/' + repository + '/commits/' + first.head + '/check-runs?filter=latest&per_page=100&page=' + page); }
    catch { break; }
    if (!obj(raw) || typeof raw.total_count !== 'number' || !Number.isSafeInteger(raw.total_count) || raw.total_count < 0 ||
        !Array.isArray(raw.check_runs) || raw.check_runs.length > 100) { invalid = true; break; }
    if (expected !== null && expected !== raw.total_count) invalid = true;
    expected = raw.total_count;
    pages++;
    for (const run of raw.check_runs) {
      if (!obj(run) || !number(run.id) || seen.has(run.id) || run.head_sha !== first.head ||
          typeof run.status !== 'string' || !['queued','in_progress','completed','waiting','requested','pending'].includes(run.status) ||
          (run.conclusion !== null && (typeof run.conclusion !== 'string' || !['success','failure','neutral','cancelled','skipped','timed_out','action_required','stale','startup_failure'].includes(run.conclusion)))) { invalid = true; continue; }
      seen.add(run.id); runs.push({id: run.id, status: run.status, conclusion: run.conclusion});
    }
    if (raw.check_runs.length < 100) { exhausted = true; break; }
  }
  let last: ReturnType<typeof pullIdentity>;
  try { last = pullIdentity(await read(path), repository, n); } catch { return {state: 'unknown', reason: 'unavailable'}; }
  if (!last || JSON.stringify(last) !== JSON.stringify(first)) return {state: 'unknown', reason: 'changed'};
  const coverage: Coverage = !pages ? 'unavailable' : exhausted && !invalid && runs.length === expected ? 'complete' : 'partial';
  return {state: 'observed', repository, number: n, head: first.head, base: first.base, baseRef: first.baseRef,
    draft: first.draft, mergeable: first.mergeable, observedAt: (options.now ?? (() => new Date()))().toISOString(),
    checks: {coverage, runs}, reviewAndRequiredControls: 'unverified'};
}
