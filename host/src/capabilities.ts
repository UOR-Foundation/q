// DA-39 is a measured host claim, not a second authorization model.
// The command registry, capability report and tests consume one catalog.
import { labelOf } from './address.ts';
import { COMMAND, type CommandName, type Kernel } from './kernel.ts';
import type { Decider } from './community.ts';
import type { Actions } from './pipeline.ts';

type Entry = {description:string; question:boolean; summary:string; policy:readonly string[]; source:string; effect?:'improve'|'open'|'feedback'|'build'};
export const DISCORD_COMMANDS: Readonly<Record<CommandName,Entry>> = {
  ask:{description:'Ask a question about the UOR Foundation',question:true,summary:'Grounded answers and community decisions',policy:['DA-06','DA-07','DA-08','DA-14'],source:'host/src/pipeline.ts'},
  search:{description:'Search the indexed sources',question:true,summary:'Find indexed sources without answer-generation inference',policy:['DA-10','DA-22','DA-31'],source:'host/src/pipeline.ts'},
  status:{description:'Show the kernel, index and capabilities',question:false,summary:'Capability map and operational self-report',policy:['DA-39'],source:'host/src/capabilities.ts'},
  reindex:{description:'Re-index the knowledge sources (admin)',question:false,summary:'Refresh knowledge sources',policy:['DA-04','DA-10'],source:'host/src/main.ts'},
  'forget-channel':{description:'Forget everything indexed from this channel (admin)',question:false,summary:'Request removal of indexed channel content',policy:['DA-04','DA-09'],source:'host/src/memory.ts'},
  'forget-me':{description:'Forget everything indexed from you, and stop indexing you',question:false,summary:'Request personal forgetting and opt-out',policy:['DA-04','DA-09'],source:'host/src/memory.ts'},
  improve:{description:'What Q is learning, and what it proposes to change (admin)',question:false,summary:'Inspect improvement review',policy:['DA-27','DA-28','DA-29','DA-35'],source:'host/src/improve.ts',effect:'improve'},
  feedback:{description:'Tell Q what to do better, or ask for a feature. Shared with the community, without your name.',question:false,summary:'Submit feedback; filing is conditional on consent and support',policy:['DA-30'],source:'host/src/improve.ts',effect:'feedback'},
  build:{description:'Describe an app: Q builds it, proves it, and links it running in its own holospace',question:false,summary:'Request a small modeled app from the configured builder',policy:['DA-04','DA-05'],source:'host/src/apps.ts',effect:'build'},
  open:{description:'Open questions, promises and requests in this server (admin)',question:false,summary:'Inspect tracked work in an eligible server',policy:['DA-04','DA-36'],source:'host/src/tracker.ts',effect:'open'},
};

// Only explicit standalone questions are routed to the existing status
// command. No retrieved text, tool metadata or model output can select it.
export function isCapabilityQuestion(question:string):boolean {
  if(typeof question!=='string'||question.length>160)return false;
  const normalized=question.trim().toLowerCase().replace(/[?!.]+$/,'').replace(/\s+/g,' ');
  return ['what can you do','what are your capabilities','what can q do','what are q\'s capabilities','show your capabilities','show me your capabilities','show me your capability map','list your capabilities'].includes(normalized);
}
type Facts = Pick<Actions,'focus'|'improve'|'open'|'feedback'|'build'|'self'>;
type ReportKernel = Pick<Kernel,'command'|'model'|'holo'|'commit'>;
export async function capabilityReport(kernel:ReportKernel, community:Decider, actions:Facts, role:'member'|'admin'){
  const commands=await Promise.all((Object.keys(COMMAND) as CommandName[]).map(async name=>{
    const entry=DISCORD_COMMANDS[name];
    if(!entry)throw new Error('command inventory mismatch');
    const decision=await kernel.command(name,role);
    return {name,summary:entry.summary,source:entry.source,policy:entry.policy,
      wiring:entry.effect&&typeof actions[entry.effect]!=='function'?'unavailable':'wired',
      eligibility:decision==='allowed'?'eligible':decision==='not authorized'?'not authorized':'unknown'};
  }));
  // These are public architectural capability groups, not a listing of
  // private integrations, source contents, tool names or service endpoints.
  const groups=[
    {name:'Live contribution discovery',wiring:typeof actions.focus==='function'?'wired':'unavailable',policy:['DA-38'],source:'host/src/focus-entry.ts',limit:'Public evidence only; bounded diagnostic preview, not work assignment.'},
    {name:'Community policy decisions',wiring:'wired',policy:['DA-14'],source:'host/src/community.ts',limit:'Signed community decisions; required inputs and applicability must be established.'},
    {name:'Conversation and knowledge lifecycle',wiring:'conditional',policy:['DA-01','DA-02','DA-09','DA-10','DA-21','DA-32','DA-33'],source:'host/src/memory.ts',limit:'Source, purpose, consent, retention and citation checks apply; this map certifies no deletion outcome.'},
    {name:'External tool integrations',wiring:'conditional',policy:['DA-19','DA-22','DA-31'],source:'host/src/tools.ts',limit:'Only configured and authorized effects; no private tool inventory or credentials disclosed.'},
    {name:'Web and agent interfaces',wiring:'conditional',policy:['DA-22','DA-31','DA-37'],source:'host/src/mcp-server.ts',limit:'Deployment dependent; public sources only off Discord.'},
    {name:'Membership administration',wiring:'conditional',policy:['DA-23'],source:'host/src/adapter/discord.ts',limit:'Configured rules confirmation, not arbitrary role grants.'},
    {name:'Evaluation and self-improvement',wiring:typeof actions.self==='function'?'wired':'unavailable',policy:['DA-24','DA-25','DA-26','DA-27','DA-28','DA-29','DA-32','DA-33','DA-34','DA-35'],source:'host/src/improve.ts',limit:'Review and learning within governed boundaries; no autonomous rule or code changes.'},
  ];
  const report={type:'uor-agent/capability-report/1',claim:'DA-39',coverage:'registered Discord commands and declared public capability groups; not an exhaustive effective-privilege audit',
    kernel:{model:kernel.model,holo:kernel.holo,commit:kernel.commit},community:{holo:community.pin.holo,commit:community.pin.commit},
    hostRevision:'not independently established',commands,groups,
    qualification:'Host wiring and command eligibility only; configuration, operational readiness and per-effect authority are distinct.'};
  return {report,label:labelOf(report)};
}
export function renderCapabilities(value:Awaited<ReturnType<typeof capabilityReport>>):string{
  const {report:r,label}=value;
  const commandLines=r.commands.map(c=>`- /${c.name}: ${c.summary}. ${c.wiring}; ${c.eligibility}. [${c.policy.join(', ')}]`);
  const groupLines=r.groups.map(g=>`- ${g.name}: ${g.wiring}. ${g.limit} [${g.policy.join(', ')}]`);
  return ['**Q capability map**','This is an inventory of registered commands and public capability groups, not a permission grant. "Eligible" is the kernel command check for this caller; further checks apply. "Wired" is host wiring, not a live success guarantee.',
    '**Commands**',...commandLines,'**Other capability groups**',...groupLines,
    'Provenance (DA-39, measured host claim): kernel model '+r.kernel.model+', holo '+r.kernel.holo+', signed kernel commit '+(r.kernel.commit??'unverified')+'. Community pin '+r.community.commit+', holo '+r.community.holo+'. Host revision '+r.hostRevision+'. Report '+label+'.',
    'Sources: model/ids.toml, CONFORMANCE.md, host/src/capabilities.ts and the named implementation modules. The report does not expose private configuration or independently certify effective privileges.'].join('\n');
}
