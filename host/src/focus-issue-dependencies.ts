// Native GitHub issue relations, not inferred dependency edges from prose.
// The observed public repository inventory is the only allowed target scope.
import type { PublicRead } from './focus-discovery.ts';
import type { LiveWorkSnapshot, WorkItem } from './focus-live-work.ts';
type Coverage = 'complete' | 'partial' | 'unavailable';
export type Dependency = {repository: string; number: number; url: string; state: 'open' | 'closed'};
export type IssueObservation =
  | {state: 'unknown'; reason: 'not-observed' | 'unavailable' | 'changed'}
  | {state: 'observed'; repository: string; number: number; updatedAt: string;
      dependencies: Dependency[]; coverage: Coverage; unresolved: number;
      completion: 'unverified'; readiness: 'unverified'};
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const name = /^UOR-Foundation\/[A-Za-z0-9_.-]{1,100}$/;
function validRepo(v: string) { return name.test(v) && !v.endsWith('/.') && !v.endsWith('/..'); }
function identify(raw: unknown, repository: string, number: number) {
  if (!obj(raw) || raw.number !== number || raw.state !== 'open' ||
      Object.hasOwn(raw, 'pull_request') ||
      raw.repository_url !== 'https://api.github.com/repos/' + repository ||
      raw.html_url !== 'https://github.com/' + repository + '/issues/' + number ||
      typeof raw.updated_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(raw.updated_at) ||
      !Number.isFinite(Date.parse(raw.updated_at)) ||
      new Date(raw.updated_at).toISOString() !== raw.updated_at.replace('Z','.000Z')) return null;
  return raw.updated_at;
}
/** Query native blocked-by relations at question time. A closed issue is not
 * proof of a satisfied prerequisite. Unsupported or off-scope relations
 * remain unresolved and their private/foreign identities are never emitted.
 * Two issue reads detect observed drift, not atomic provider consistency.
 */
export async function inspectLiveIssue(read: PublicRead, snapshot: LiveWorkSnapshot,
  item: Pick<WorkItem,'repository'|'number'>, maxPages = 2): Promise<IssueObservation> {
  if (!num(maxPages) || maxPages > 20) throw RangeError('invalid dependency page budget');
  if (!validRepo(item.repository) || !num(item.number)) return {state:'unknown',reason:'not-observed'};
  const repos = snapshot.repositories.filter(r => r.repository === item.repository);
  if (repos.length !== 1 || repos[0].items.filter(i=>i.repository===item.repository && i.number===item.number && i.kind==='issue').length!==1)
    return {state:'unknown',reason:'not-observed'};
  const path = '/repos/' + item.repository + '/issues/' + item.number;
  let first: string | null;
  try { first = identify(await read(path),item.repository,item.number); }
  catch { return {state:'unknown',reason:'unavailable'}; }
  if (!first) return {state:'unknown',reason:'changed'};
  const scope = new Set(snapshot.repositories.filter(r=>validRepo(r.repository)).map(r=>r.repository));
  const dependencies: Dependency[] = [];
  const seen = new Set<string>();
  let pages=0, exhausted=false, unresolved=0;
  for (let page=1;page<=maxPages;page++) {
    let rows: unknown;
    try { rows = await read(path+'/dependencies/blocked_by?per_page=100&page='+page); }
    catch { break; }
    if (!Array.isArray(rows) || rows.length>100) { unresolved++; break; }
    pages++;
    for (const row of rows) {
      if (!obj(row) || !num(row.number) || typeof row.repository_url!=='string' ||
          Object.hasOwn(row,'pull_request') || (row.state!=='open' && row.state!=='closed')) { unresolved++; continue; }
      const prefix='https://api.github.com/repos/';
      const repository=row.repository_url.startsWith(prefix)?row.repository_url.slice(prefix.length):'';
      const url='https://github.com/'+repository+'/issues/'+row.number;
      const key=repository+'#'+row.number;
      if (!scope.has(repository) || row.html_url!==url ||
          (repository===item.repository && row.number===item.number) || seen.has(key)) { unresolved++; continue; }
      seen.add(key);
      dependencies.push({repository,number:row.number,url,state:row.state});
    }
    if (rows.length<100) {exhausted=true;break;}
  }
  let last: string|null;
  try { last=identify(await read(path),item.repository,item.number); }
  catch {return {state:'unknown',reason:'unavailable'};}
  if (!last || last!==first) return {state:'unknown',reason:'changed'};
  return {state:'observed',repository:item.repository,number:item.number,updatedAt:first,dependencies,
    coverage:!pages?'unavailable':exhausted&&!unresolved?'complete':'partial',unresolved,completion:'unverified',readiness:'unverified'};
}
