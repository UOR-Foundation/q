// Direct, bounded rendering of public live observations, not another LLM
// answer and not a reusable memory. Only provider-bound identities and
// measured facts reach the surface; titles, bodies and author IDs do not.
import type { assessFocus } from './focus-assessment.ts';

type Assessment = Awaited<ReturnType<typeof assessFocus>>;

// Cheap candidate prefilter, not a policy decision or classification.
// Other questions retain their existing path and inference budget.
export function possibleFocusQuestion(question: string): boolean {
  if(typeof question!=='string'||question.length>4000)return false;
  return /\b(?:what|which|where)\b/i.test(question) &&
    /\b(?:should|could|can|best|most valuable|highest[- ]impact|next)\b/i.test(question) &&
    /\b(?:work on|contribut(?:e|ion|ions)|tackle|prioriti[sz]e|focus on)\b/i.test(question);
}
const instructions = {
  'inspect-conflict':'Investigate the merge conflict and identify the files requiring reconciliation.',
  'inspect-failed-check':'Open the failed check for the observed PR head and identify the first failing step.',
  'verify-prerequisite':'Verify the prerequisite and its acceptance evidence before advancing dependent work.',
  'confirm-contribution-readiness':'Confirm the issue or PR acceptance criteria, ownership, and any remaining blockers.',
  'refresh-evidence':'Refresh the work item and confirm whether its state or dependencies changed.',
} as const;

export function renderFocus(data: Assessment): string {
  const lines = ['**Live contribution assessment**'];
  if(data.state==='cancelled')return 'Live contribution assessment was cancelled.';
  const p=data.projection;
  lines.push('Public GitHub scan: '+data.sourceCoverage+'; '+p.matchingRepositories+' repositories matched, '+p.matchingItems+' work items matched.');
  if(data.search){
    const s=data.search;
    const outcome={read:'every reported item was read',capped:'stopped at the '+s.pages+'-page budget',interrupted:'a later page failed after '+s.pages,
      unavailable:'the search could not be read (refused, rate-limited or unreachable); no open work was read',fallback:'the search response was malformed, so each repository was read separately instead'}[s.state];
    if(s.state==='unavailable'||s.state==='fallback')lines.push('GitHub search index: '+outcome+'.');
    else lines.push('Open work for the '+data.repositoryCoverage.length+' listed repositories came from the GitHub search index: '+s.read+' of '+s.totalCount+' open items read from '+s.pages+' page'+(s.pages===1?'':'s')+'; '+outcome+(s.incomplete?'; GitHub marked the search incomplete':'')+'. The index can lag the repositories, so this is never a complete snapshot, and a repository with no returned items is unknown, not idle.');
  }
  lines.push('Inspected '+(data.issues.length+data.pulls.length)+' candidates; '+p.omittedMatchingItems+' matching items and '+p.omittedRepositories+' known repositories omitted; '+p.unavailableRepositories+' matching-scope repositories incomplete or unavailable. This is not a Foundation-wide optimum.');
  const scoped = data.repositoryCoverage.filter(r=>/^UOR-Foundation\/[A-Za-z0-9_.-]{1,100}$/.test(r.repository)).slice(0,24);
  const names = scoped.map(r=>r.repository.slice('UOR-Foundation/'.length)+' ('+r.coverage+')').join(', ');
  if(names)lines.push('Repository coverage: '+names.slice(0,600)+(names.length>600?'…':'')+'.');
  lines.push('Foundation objectives and contributor authority have not been independently established.');
  if(data.plan.state==='invalid')lines.push('The observed task graph is inconsistent. No implementation recommendation is established.');
  else if(!data.diagnosticChoices.length)lines.push('No supported next investigation was established from the inspected evidence.');
  else {
    for(const [i,c] of data.diagnosticChoices.slice(0,2).entries()){
      // Guard the rendering boundary independently; do not copy arbitrary
      // links or unknown action text from a mutable observation.
      const m=/^UOR-Foundation\/([A-Za-z0-9_.-]{1,100})$/.exec(c.repository);
      if(!m||m[1]==='.'||m[1]==='..'||!Number.isSafeInteger(c.number)||c.number<=0||
        !Object.hasOwn(instructions,c.action)||
        !['issues','pull'].some(kind=>c.url==='https://github.com/'+c.repository+'/'+kind+'/'+c.number))continue;
      const head=typeof c.head==='string'&&/^[a-f0-9]{40}$/.test(c.head)?' (head '+c.head.slice(0,12)+')':'';
      const dependents=Number.isSafeInteger(c.observedDependents)&&c.observedDependents>0?
        ' Observed open dependents: '+c.observedDependents+'.':'';
      lines.push((i===0?'First investigation: ':'Alternative: ')+'['+c.repository+'#'+c.number+'](<'+c.url+'>)'+head+'. '+instructions[c.action]+dependents);
    }
  }
  lines.push('Observed '+data.finishedAt+'. Implementation readiness, authority, and priority remain unverified.');
  return lines.join('\n\n');
}
