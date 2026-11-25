// Prototype: public repository inventory facts for Q Focus. Not wired into the
// runtime. This module makes no eligibility, authority or compliance decision.
// The caller supplies a public-only, GET-only transport with time/byte limits;
// never pass a privileged connector that can disclose nonpublic resources.
export type PublicRead = (path: string) => Promise<unknown>;

const ORG = 'UOR-Foundation';
const PAGE_SIZE = 100;
const SHA = /^[a-f0-9]{40}$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}$/;
const FILES = [
  'README.md', 'GOVERNANCE.md', 'SECURITY.md', 'MAINTAINERS.md',
  'ARCHITECTURE_INDEX.md', 'AGENTS.md', 'CLAUDE.md',
  '.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS',
  'template.lock', 'template-contract.json', 'docs/qortara-template-pin.json',
  '.qortara/.gitignore', '.qortara/ledger.jsonl', '.qortara/shadow.jsonl',
  'governance/GOVERNANCE.md', 'governance/OPERATING_MODEL.md',
  'governance/CONFORMANCE_REPORTING.md',
] as const;

type FilePath = typeof FILES[number];
type Presence = 'present' | 'absent' | 'unknown';
type InventoryState = 'complete' | 'partial' | 'unavailable';
type SourceFailure = 'branch-unavailable' | 'tree-unavailable' | 'tree-truncated' | 'tree-invalid';
export interface RepositoryObservation {
  repository: string;
  defaultBranch: string;
  commit: string | null;
  tree: InventoryState;
  files: Record<FilePath, Presence>;
  failures: SourceFailure[];
}
export interface PublicInventory {
  organization: typeof ORG;
  observedAt: string;
  enumeration: InventoryState;
  coverage: InventoryState;
  pagesRead: number;
  repositories: RepositoryObservation[];
  excluded: { archivedOrFork: number; nonpublicOrInvalid: number; duplicate: number; budget: number };
  failures: ('page-unavailable' | 'page-invalid' | 'page-budget' | 'repository-budget' | 'duplicate-repository' | 'invalid-record')[];
}

const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const presence = (value: Presence) => Object.fromEntries(FILES.map(path => [path, value])) as Record<FilePath, Presence>;
function bounded(value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new RangeError('invalid inventory budget');
  return value;
}

function publicRepository(row: unknown): row is { name: string; full_name: string; default_branch: string; archived: boolean; fork: boolean; private: false; visibility: 'public' } {
  if (!object(row) || row.private !== false || row.visibility !== 'public' ||
      typeof row.name !== 'string' || !REPO.test(row.name) || row.name === '.' || row.name === '..' ||
      row.full_name !== ORG + '/' + row.name ||
      typeof row.default_branch !== 'string' || row.default_branch.length === 0 ||
      row.default_branch.length > 255 || /[\x00-\x1f\x7f]/.test(row.default_branch) ||
      typeof row.archived !== 'boolean' || typeof row.fork !== 'boolean') return false;
  return true;
}

async function inspect(read: PublicRead, repo: { name: string; default_branch: string }): Promise<RepositoryObservation> {
  const repository = ORG + '/' + repo.name;
  const result: RepositoryObservation = {
    repository, defaultBranch: repo.default_branch, commit: null, tree: 'unavailable',
    files: presence('unknown'), failures: [],
  };
  const base = '/repos/' + ORG + '/' + encodeURIComponent(repo.name);
  try {
    const commit = await read(base + '/commits/' + encodeURIComponent(repo.default_branch));
    if (!object(commit) || typeof commit.sha !== 'string' || !SHA.test(commit.sha)) throw new Error('invalid commit');
    result.commit = commit.sha;
  } catch {
    result.failures.push('branch-unavailable');
    return result;
  }
  let tree: unknown;
  try { tree = await read(base + '/git/trees/' + result.commit + '?recursive=1'); }
  catch { result.failures.push('tree-unavailable'); return result; }
  if (!object(tree) || typeof tree.truncated !== 'boolean' || !Array.isArray(tree.tree)) {
    result.failures.push('tree-invalid'); return result;
  }
  // Negative evidence needs a complete and valid tree. Do not emit arbitrary
  // paths from an API response; the output is the fixed public discovery set.
  const seen = new Set<string>();
  let invalid = false;
  for (const entry of tree.tree) {
    if (!object(entry) || typeof entry.path !== 'string' || typeof entry.type !== 'string' ||
        !['blob','tree','commit'].includes(entry.type) || seen.has(entry.path)) { invalid = true; continue; }
    seen.add(entry.path);
    if (entry.type === 'blob' && FILES.includes(entry.path as FilePath)) result.files[entry.path as FilePath] = 'present';
  }
  if (tree.truncated) result.failures.push('tree-truncated');
  if (invalid) result.failures.push('tree-invalid');
  if (result.failures.length) { result.tree = 'partial'; return result; }
  result.tree = 'complete';
  for (const path of FILES) if (result.files[path] !== 'present') result.files[path] = 'absent';
  return result;
}

/** A bounded observation, not an atomic snapshot or proof of organization visibility.
 * observedAt is the caller's collection-start time, not authenticated freshness.
 * The read transport must enforce public scope, no redirects to private sources,
 * timeout/response limits and credentials independently of this prototype.
 */
export async function collectPublicInventory(read: PublicRead, options: {
  observedAt: string; maxPages?: number; maxRepositories?: number;
}): Promise<PublicInventory> {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(options.observedAt) ||
      !Number.isFinite(Date.parse(options.observedAt)) ||
      new Date(options.observedAt).toISOString() !== options.observedAt) throw new RangeError('invalid observation time');
  const maxPages = bounded(options.maxPages ?? 10, 100);
  const maxRepos = bounded(options.maxRepositories ?? 200, 1000);
  const report: PublicInventory = {
    organization: ORG, observedAt: options.observedAt, enumeration: 'unavailable', coverage: 'unavailable',
    pagesRead: 0, repositories: [],
    excluded: { archivedOrFork: 0, nonpublicOrInvalid: 0, duplicate: 0, budget: 0 },
    failures: [],
  };
  const seen = new Set<string>();
  const candidates: { name: string; default_branch: string }[] = [];
  let exhausted = false;
  for (let page = 1; page <= maxPages; page++) {
    let rows: unknown;
    try { rows = await read('/orgs/' + ORG + '/repos?type=public&sort=full_name&direction=asc&per_page=100&page=' + page); }
    catch { report.failures.push('page-unavailable'); break; }
    if (!Array.isArray(rows) || rows.length > PAGE_SIZE) { report.failures.push('page-invalid'); break; }
    report.pagesRead++;
    for (const row of rows) {
      if (!publicRepository(row)) {
        report.excluded.nonpublicOrInvalid++;
        if (!report.failures.includes('invalid-record')) report.failures.push('invalid-record');
        continue;
      }
      const key = row.name.toLowerCase();
      if (seen.has(key)) {
        report.excluded.duplicate++;
        if (!report.failures.includes('duplicate-repository')) report.failures.push('duplicate-repository');
        continue;
      }
      seen.add(key);
      if (row.archived || row.fork) { report.excluded.archivedOrFork++; continue; }
      if (candidates.length >= maxRepos) { report.excluded.budget++; continue; }
      candidates.push({ name: row.name, default_branch: row.default_branch });
    }
    if (rows.length < PAGE_SIZE) { exhausted = true; break; }
  }
  if (!exhausted && report.pagesRead === maxPages) report.failures.push('page-budget');
  if (report.excluded.budget) report.failures.push('repository-budget');
  report.enumeration = report.pagesRead === 0 ? 'unavailable' :
    exhausted && !report.failures.some(f => f !== 'repository-budget') ? 'complete' : 'partial';
  // Sequential reads keep the transport's rate budget and trace predictable.
  for (const repo of candidates) report.repositories.push(await inspect(read, repo));
  report.coverage = report.enumeration === 'unavailable' ? 'unavailable' :
    report.enumeration === 'complete' && !report.excluded.budget && report.repositories.every(repo => repo.tree === 'complete')
      ? 'complete' : 'partial';
  return report;
}
