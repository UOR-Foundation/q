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
  /** GitHub's own issue-dependency counts: how many items this blocks, and is blocked by. Null when not supplied. */
  blocking?: number | null; blockedBy?: number | null;
};
type RepoWork = { repository: string; defaultBranch: string; topics: string[] | null; coverage: Coverage; items: WorkItem[] };
export type LiveWorkSnapshot = {
  startedAt: string; finishedAt: string; coverage: Coverage;
  enumeration: Coverage; repositories: RepoWork[];
  omittedRepositories: number; invalidRecords: number;
  /**
   * Set when the organization-wide search index was tried. `read`: every reported item was read; `capped`: the page
   * budget ran out first; `interrupted`: a later page failed; `unavailable`: the first page could not be read (refused,
   * rate-limited or unreachable), so nothing was read and no fallback was tried; `fallback`: the response was
   * malformed, the transport still had budget, and the per-repository scan was used instead.
   * 'inconsistent': the reported counts, page lengths or record identities disagree.
   */
  search?: { state: 'read' | 'capped' | 'interrupted' | 'unavailable' | 'fallback' | 'inconsistent'; pages: number; totalCount: number; read: number; incomplete: boolean; excluded: number;
    /** The time share for search ran out before every page was read. */
    stoppedForTime?: boolean; unknownTotalKinds?: number };
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
    title: row.title.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 256), updatedAt: row.updated_at, assigned: row.assignees.length > 0, labels: metadata(row.labels, true),
    ...dependencyCounts(row.issue_dependencies_summary) };
}
const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
function dependencyCounts(raw: unknown): { blocking: number | null; blockedBy: number | null } {
  if (!obj(raw)) return { blocking: null, blockedBy: null };
  return { blocking: count(raw.total_blocking), blockedBy: count(raw.total_blocked_by) };
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
  /** Prefer an explicitly named repository within the observed public scope. */
  preferredRepository?: string;
  /** Read open work for every listed repository through one organization-wide search, instead of per repository. */
  orgWide?: boolean;
  /** Pages of that search (100 items each, at most 10 in all), budgeted apart from the per-repository fallback. */
  maxSearchPages?: number;
  /** No new search page is started after this many milliseconds, so candidate details keep time within the deadline. */
  searchTimeMs?: number;
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
      candidates.push({repository: ORG + '/' + row.name, defaultBranch: row.default_branch, topics: metadata(row.topics)});
    }
    if (rows.length < 100) { orgExhausted = true; break; }
  }
  const enumeration: Coverage = !pages ? 'unavailable' : orgExhausted && !invalidRecords ? 'complete' : 'partial';
  let fellBack: LiveWorkSnapshot['search'];
  if (options.orgWide && !options.preferredRepository && candidates.length) {
    // At least one page of each kind by default: a single page could never reach the pull-request query.
    const searched = await searchWork(read, candidates, bound(options.maxSearchPages ?? 2, 10), options.searchTimeMs);
    if (searched.state !== 'fallback') {
      // The search index can lag even after pagination ends. A repository
      // with no retained hits remains unknown, not evidence of inactivity.
      return {startedAt, finishedAt: now().toISOString(), coverage: enumeration === 'unavailable' || searched.state === 'unavailable' ? 'unavailable' : 'partial', enumeration,
        repositories: candidates.map(c => {
          const items = searched.items.get(c.repository) ?? [];
          return {...c, items, coverage: (items.length ? 'partial' : 'unavailable') as Coverage};
        }),
        omittedRepositories: 0, invalidRecords: invalidRecords + searched.invalid, search: searched.summary};
    }
    // Malformed but delivered: the transport still has budget, so the bounded per-repository scan below is used.
    fellBack = searched.summary;
  }
  const repositories: RepoWork[] = [];
  const preferred = options.preferredRepository?.toLowerCase();
  if (preferred) candidates.sort((a,b) => Number(b.repository.toLowerCase() === preferred) - Number(a.repository.toLowerCase() === preferred));
  omittedRepositories = Math.max(0, candidates.length - maxRepos);
  for (const candidate of candidates.slice(0,maxRepos)) {
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
  return {startedAt, finishedAt: now().toISOString(), coverage, enumeration, repositories, omittedRepositories, invalidRecords, ...(fellBack ? {search: fellBack} : {})};
}

/** Open work of the listed public, active repositories from the organization-wide search index. Items of any other
 * repository (private, archived, forked, unlisted) are excluded and counted, never kept. */
async function searchWork(read: PublicRead, candidates: { repository: string }[], maxPages: number, timeMs = Infinity) {
  const listed = new Map(candidates.map(c => [('https://api.github.com/repos/' + c.repository).toLowerCase(), c.repository]));
  const items = new Map<string, WorkItem[]>();
  const seen = new Set<string>();
  let readCount = 0, incomplete = false, excluded = 0, invalid = 0, pages = 0, inconsistent = false, failed = false, malformedFirst = false;
  const started = performance.now();
  // Issues and pull requests, one page of each in turn, so a page budget never silently drops a whole kind.
  const kinds = (['issue', 'pull-request'] as const).map(kind => ({ kind, next: 1, done: false, total: -1, received: 0 }));
  let timedOut = false;
  while (pages < maxPages && kinds.some(k => !k.done)) {
    for (const k of kinds) {
      if (k.done || pages >= maxPages) continue;
      if (performance.now() - started >= timeMs) { timedOut = true; break; }
      let raw: unknown;
      try { raw = await read('/search/issues?q=org%3AUOR-Foundation+is%3Aopen+is%3A' + k.kind + '+archived%3Afalse&sort=created&order=asc&per_page=100&page=' + k.next); }
      catch { failed = true; k.done = true; continue; }
      if (!obj(raw) || typeof raw.total_count !== 'number' || !Number.isSafeInteger(raw.total_count) || raw.total_count < 0 ||
          typeof raw.incomplete_results !== 'boolean' || !Array.isArray(raw.items) || raw.items.length > 100) {
        // A malformed very first response means the search is unusable while the transport still works: fall back.
        if (!pages && !failed) { malformedFirst = true; kinds.forEach(other => { other.done = true; }); break; }
        failed = true; k.done = true; continue;
      }
      if (k.total >= 0 && k.total !== raw.total_count) inconsistent = true;
      pages++;
      k.total = raw.total_count;
      k.received += raw.items.length;
      incomplete ||= raw.incomplete_results;
      for (const row of raw.items) {
        const repository = obj(row) && typeof row.repository_url === 'string' ? listed.get(row.repository_url.toLowerCase()) : undefined;
        if (!repository) { excluded++; continue; }
        const item = workItem(row, repository);
        const key = repository + '#' + (obj(row) ? String(row.number) : '');
        if (!item || seen.has(key)) { invalid++; continue; }
        // The kind a query asked for is the kind it must return.
        if ((item.kind === 'pull') !== (k.kind === 'pull-request')) { invalid++; continue; }
        seen.add(key);
        readCount++;
        (items.get(repository) ?? items.set(repository, []).get(repository)!).push(item);
      }
      if (raw.items.length < 100 || k.next * 100 >= raw.total_count) k.done = true;
      k.next++;
    }
    if (timedOut) break;
  }
  const totalCount = kinds.reduce((n, k) => n + Math.max(0, k.total), 0);
  const exhausted = kinds.every(k => k.done) && !failed;
  let state: 'read' | 'capped' | 'interrupted' | 'unavailable' | 'fallback' | 'inconsistent' =
    !pages ? (malformedFirst && !failed ? 'fallback' : 'unavailable') : failed ? 'interrupted' : exhausted ? 'read' : 'capped';
  const received = kinds.reduce((n, k) => n + k.received, 0);
  if (state === 'read' && (inconsistent || invalid > 0 || received !== totalCount)) state = 'inconsistent';
  if (state === 'capped' && (inconsistent || invalid > 0)) state = 'inconsistent';
  return { state, items, invalid, summary: { state, pages, totalCount, read: readCount, incomplete, excluded, ...(timedOut ? { stoppedForTime: true } : {}), ...(kinds.some(k=>k.total<0) ? {unknownTotalKinds:kinds.filter(k=>k.total<0).length} : {}) } };
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
