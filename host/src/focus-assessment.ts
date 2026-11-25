// Question-time Focus assessment. Deterministic host facts only, no LLM calls,
// new access, writes or claims of implementation eligibility. Not wired into
// the production pipeline; Prism registration and acceptance precede that.
import { createHash } from 'node:crypto';
import type { PublicRead } from './focus-discovery.ts';
import { collectLiveWork, inspectLivePull, type PullObservation } from './focus-live-work.ts';
import { projectDiscovery, type DiscoveryFilter } from './focus-discovery-projection.ts';
import { inspectLiveIssue, type IssueObservation } from './focus-issue-dependencies.ts';
import { recommendWork, type Task } from './focus-task-plan.ts';

type WorkRef = { repository: string; number: number };
type Diagnostic = WorkRef & {
  url: string;
  action: 'inspect-conflict' | 'inspect-failed-check' | 'verify-prerequisite' | 'confirm-contribution-readiness' | 'refresh-evidence';
  // Number of observed candidate issues declaring this issue as a blocker.
  observedDependents: number;
  head?: string;
  checkIds?: number[];
};
type Target = WorkRef & { id: string; kind: 'issue' | 'pull'; url: string; observedState: 'open' | 'closed' | 'conflicted' };
const keyOf = (r: WorkRef) => r.repository.toLowerCase() + '#' + r.number;
const idOf = (r: WorkRef) => 'work-' + createHash('sha256').update(keyOf(r)).digest('hex');
const MAX_GRAPH = 200;
const FAIL = new Set(['failure','timed_out','action_required','startup_failure']);

/** Live evidence is the input, not a manually supplied task list. A closed
 * issue is not a verified completion receipt, a passing check is not
 * permission, and a list result cannot establish objective alignment.
 * Missing readiness, effort, value and priority are not guessed. A distinct
 * diagnostic choice is a proposed read-only investigation, not permission to
 * implement, merge, assign, or claim a global optimum.
 */
export async function assessFocus(read: PublicRead, options: {
  filter?: DiscoveryFilter; maxCandidates?: number;
  maxOrgPages?: number; maxRepositories?: number; maxWorkPages?: number;
  now?: () => Date; signal?: AbortSignal;
} = {}) {
  const limit = options.maxCandidates ?? 4;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 6) throw RangeError('invalid focus detail budget');
  const guard: PublicRead = async path => {
    if (options.signal?.aborted) throw Error('focus cancelled');
    return read(path);
  };
  const snapshot = await collectLiveWork(guard, {...options, preferredRepository:options.filter?.repository});
  const projection = projectDiscovery(snapshot, options.filter, limit);
  const targets = new Map<string, Target>();
  const tasks = new Map<string, Task>();
  const issues: { target: Target; observation: IssueObservation }[] = [];
  const pulls: { target: Target; observation: PullObservation }[] = [];
  let omittedDependencies = 0;
  const targetFor = (r: WorkRef & {kind: Target['kind']; url: string}, state: 'open' | 'closed') => {
    const key = keyOf(r);
    const prior = targets.get(key);
    if (prior) {
      if (prior.observedState !== state || prior.kind !== r.kind) prior.observedState = 'conflicted';
      return prior;
    }
    if (targets.size >= MAX_GRAPH) { omittedDependencies++; return null; }
    const target: Target = {repository:r.repository, number:r.number, id:idOf(r), kind:r.kind, url:r.url, observedState:state};
    targets.set(key,target);
    // No observed GitHub state proves implementation readiness or completion.
    tasks.set(target.id,{id:target.id,kind:'action',state:state==='open'?'todo':'unknown',
      eligibility:'unknown',dependsOn:[],obligation:'discretionary',effortMinutes:null,value:null});
    return target;
  };
  for (const item of projection.candidates) targetFor(item,'open');
  for (const item of projection.candidates) {
    const target = targets.get(keyOf(item))!;
    if (options.signal?.aborted) break;
    if (item.kind === 'pull') {
      pulls.push({target,observation:await inspectLivePull(guard,snapshot,item.repository,item.number,{maxCheckPages:1,now:options.now})});
      continue;
    }
    let observation = await inspectLiveIssue(guard,snapshot,item,1);
    if (observation.state==='observed' && observation.updatedAt!==item.updatedAt) observation={state:'unknown',reason:'changed'};
    issues.push({target,observation});
    if (observation.state!=='observed') continue;
    const deps = [];
    for (const dep of observation.dependencies) {
      const other = targetFor({...dep,kind:'issue'},dep.state);
      if (other) deps.push(other.id);
    }
    tasks.set(target.id,{...tasks.get(target.id)!,dependsOn:deps,
      eligibility:observation.dependencies.some(d=>d.state==='open')?'blocked':'unknown'});
  }
  const conflicted = [...targets.values()].filter(t=>t.observedState==='conflicted');
  for (const t of conflicted) tasks.set(t.id,{...tasks.get(t.id)!,state:'unknown',eligibility:'unknown'});
  // The planner's input scope is always explicitly partial: selecting and
  // inspecting a shortlist is not a qualified task/obligation inventory.
  const plan = recommendWork({tasks:[...tasks.values()],coverage:'partial'});
  const diagnostics: Diagnostic[] = [];
  const dependents = new Map<string,number>();
  for(const {observation} of issues) if(observation.state==='observed') {
    for(const dep of observation.dependencies) if(dep.state==='open') {
      const key=keyOf(dep);
      dependents.set(key,(dependents.get(key)??0)+1);
    }
  }
  for (const {target,observation:o} of issues) {
    const n=dependents.get(keyOf(target))??0;
    // Do not advise beginning an issue whose dependency state is unresolved.
    // Inspect the prerequisite itself, not its blocked dependent, where known.
    if(o.state==='unknown' || o.coverage!=='complete') {
      diagnostics.push({...ref(target),action:'refresh-evidence',observedDependents:n});
    } else if(o.dependencies.length===0) {
      diagnostics.push({...ref(target),action:'confirm-contribution-readiness',observedDependents:n});
    } else {
      for(const dep of o.dependencies) {
        const t=targets.get(keyOf(dep));
        if(t && t.observedState!=='conflicted') diagnostics.push({...ref(t),action:'verify-prerequisite',observedDependents:dependents.get(keyOf(t))??0});
      }
    }
  }
  for (const {target,observation:o} of pulls) {
    if(o.state==='unknown') {
      diagnostics.push({...ref(target),action:'refresh-evidence',observedDependents:0});
      continue;
    }
    const failed=o.checks.runs.filter(r=>r.status==='completed'&&r.conclusion!==null&&FAIL.has(r.conclusion));
    if(o.mergeable===false) diagnostics.push({...ref(target),action:'inspect-conflict',head:o.head,observedDependents:0});
    else if(failed.length) diagnostics.push({...ref(target),action:'inspect-failed-check',head:o.head,checkIds:failed.map(r=>r.id),observedDependents:0});
    else diagnostics.push({...ref(target),action:'confirm-contribution-readiness',head:o.head,observedDependents:0});
  }
  const order: Record<Diagnostic['action'],number>={'inspect-conflict':0,'inspect-failed-check':0,'verify-prerequisite':1,
    'confirm-contribution-readiness':2,'refresh-evidence':3};
  diagnostics.sort((a,b)=>b.observedDependents-a.observedDependents || order[a.action]-order[b.action] ||
    keyOf(a).localeCompare(keyOf(b)));
  const seen = new Set<string>();
  const choices = diagnostics.filter(d=>{
    const key=keyOf(d);
    if(seen.has(key)||targets.get(key)?.observedState==='conflicted')return false;
    seen.add(key);return true;
  }).slice(0,2);
  return {state:options.signal?.aborted?'cancelled' as const:'assessed' as const,
    startedAt:snapshot.startedAt,finishedAt:(options.now??(()=>new Date()))().toISOString(),
    sourceCoverage:snapshot.coverage,projection,issues,pulls,targets:[...targets.values()],
    omittedDependencies,plan,
    diagnosticChoices:options.signal?.aborted||plan.state==='invalid'?[]:choices,
    recommendationBasis:'observed-blockers-and-read-only-investigation-not-execution-readiness' as const};
}
function ref(t:Target):WorkRef & {url:string} {
  return {repository:t.repository,number:t.number,url:t.url};
}
