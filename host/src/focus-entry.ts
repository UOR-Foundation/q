// Callable, model-gated entry to the Focus assessment. The existing answer
// pipeline must supply admitted request and community-candidate facts after
// its own access, filtering and rate checks. This module does not publish,
// persist or cache answers and does not accept user-supplied policy facts.
import type { Kernel } from './kernel.ts';
import type { Llm } from './providers.ts';
import { selectStrategy } from './focus-strategy.ts';
import { assessFocus } from './focus-assessment.ts';
import { createPublicRead } from './focus-public-read.ts';
import type { DiscoveryFilter } from './focus-discovery-projection.ts';

type Admission = {
  admitted: boolean;
  community: 'not-applicable' | 'applicable' | 'unknown';
  scope: 'public' | 'other';
};
type Result = {kind:'hold'|'ordinary'|'clarify'|'unavailable'} |
  {kind:'assessment'; data:Awaited<ReturnType<typeof assessFocus>>};

export async function runFocus(kernel: Pick<Kernel,'focusCollect'>, model: Pick<Llm,'complete'>,
  question:string, admission:Admission, options:{
    filter?:DiscoveryFilter; signal?:AbortSignal;
    // Only test harnesses inject fetch. Production uses anonymous fixed-origin
    // transport, not Q's authenticated GitHub ingestion token.
    fetcher?:typeof fetch;
  }={}):Promise<Result> {
  if(options.signal?.aborted)return {kind:'hold'};
  if(admission.admitted!==true || admission.scope!=='public' || admission.community!=='not-applicable') {
    // Avoid even classification when the caller has no admitted public
    // request or a community decision might apply.
    return {kind:'hold'};
  }
  const route=await selectStrategy(model,question,{communityDecision:admission.community,availableEvidence:new Set()},options.signal);
  if(route.kind==='clarify')return {kind:'clarify'};
  if(route.kind==='unavailable')return {kind:'unavailable'};
  if(route.kind!=='strategy'||route.intent!=='focus')return {kind:'ordinary'};
  if(options.signal?.aborted)return {kind:'hold'};
  try {
    const decision=await kernel.focusCollect('focus',admission.community,admission.scope,admission.admitted);
    if(decision!=='collect'||options.signal?.aborted)return {kind:'hold'};
  } catch {return {kind:'unavailable'};}
  // Reserve the operation's limited anonymous budget for deeper evidence
  // by bounding the first pass. This provisional scope cap must be
  // measured; the assessment explicitly reports partial coverage.
  const {read}=createPublicRead({maxRequests:40,deadlineMs:15000,signal:options.signal,fetcher:options.fetcher});
  // Extract only explicit organization/repository identities. Never infer a
  // repository from vague prose or follow a URL supplied by a question.
  // Trailing periods are sentence punctuation, not part of a GitHub name.
  const references = [...question.matchAll(/\bUOR-Foundation\/([A-Za-z0-9_.-]{1,100})(?![A-Za-z0-9_.-])/gi)];
  const names = references.map(m => m[1].replace(/\.+$/,''));
  // An explicit but invalid identity is not permission to widen the scan.
  if (names.some(name => !name)) return {kind:'clarify'};
  const named = [...new Set(names.map(name => ('UOR-Foundation/'+name).toLowerCase()))];
  if(named.length>1)return {kind:'clarify'};
  if(named.length===1 && options.filter?.repository && options.filter.repository.toLowerCase()!==named[0])return {kind:'clarify'};
  const filter = named.length ? {...options.filter,repository:named[0].replace(/^uor-foundation\//,'UOR-Foundation/')} : options.filter;
  // Without a named repository, open work is read for every listed repository through one organization-wide search
  // page; the per-repository scan (24 repositories) remains the fallback and the path for a named repository.
  // Seven search pages (700 items) and one listing page leave at least 32 of the 40 requests for candidate details.
  const data=await assessFocus(read,{filter,maxRepositories:24,maxWorkPages:1,maxSearchPages:7,maxCandidates:4,orgWide:!filter?.repository,signal:options.signal});
  return options.signal?.aborted||data.state==='cancelled'?{kind:'hold'}:{kind:'assessment',data};
}
