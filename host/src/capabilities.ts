// DA-39 is a measured host claim, not a second authorization model.
// The command registry, capability report and tests consume one catalog.
import { labelOf } from './address.ts';
import { COMMAND, type CommandName, type Kernel } from './kernel.ts';
import type { Decider } from './community.ts';
import type { Actions } from './pipeline.ts';
import { MCP_PUBLIC_TOOLS } from './mcp-server.ts';

type Entry = {description:string; question:boolean; summary:string; policy:readonly string[]; source:string; effect?:'improve'|'open'|'feedback'|'build'};
export const DISCORD_COMMANDS: Readonly<Record<CommandName,Entry>> = {
  ask:{description:'Ask a question about the UOR Foundation',question:true,summary:'Grounded answers and community decisions',policy:['DA-06','DA-07','DA-08','DA-14'],source:'host/src/pipeline.ts'},
  search:{description:'Search the indexed sources',question:true,summary:'Find indexed sources without answer-generation inference',policy:['DA-10','DA-22','DA-31'],source:'host/src/pipeline.ts'},
  status:{description:'Show the kernel, index and capabilities',question:false,summary:'Capability map and operational self-report',policy:['DA-39'],source:'host/src/capabilities.ts'},
  reindex:{description:'Re-index the knowledge sources (admin)',question:false,summary:'Refresh knowledge sources',policy:['DA-04','DA-10'],source:'host/src/main.ts'},
  'forget-channel':{description:'Request forgetting indexed channel content (admin)',question:false,summary:'Request removal of indexed channel content',policy:['DA-04','DA-09'],source:'host/src/memory.ts'},
  'forget-me':{description:'Request personal forgetting and opt-out',question:false,summary:'Request personal forgetting and opt-out',policy:['DA-04','DA-09'],source:'host/src/memory.ts'},
  improve:{description:'What Q is learning, and what it proposes to change (admin)',question:false,summary:'Inspect improvement review',policy:['DA-27','DA-28','DA-29','DA-35'],source:'host/src/improve.ts',effect:'improve'},
  feedback:{description:'Submit feedback or request a feature',question:false,summary:'Submit feedback; filing is conditional on consent and support',policy:['DA-30'],source:'host/src/improve.ts',effect:'feedback'},
  build:{description:'Request a modeled app when the builder is configured',question:false,summary:'Request a small modeled app from the configured builder',policy:['DA-04','DA-05'],source:'host/src/apps.ts',effect:'build'},
  open:{description:'Open questions, promises and requests in this server (admin)',question:false,summary:'Inspect tracked work in an eligible server',policy:['DA-04','DA-36'],source:'host/src/tracker.ts',effect:'open'},
};

// Only explicit standalone questions are routed to the existing status
// command. No retrieved text, tool metadata or model output can select it.
export function capabilityDetail(question:string):'summary'|'full'|null {
  if(typeof question!=='string'||question.length>160)return null;
  const q=question.trim().toLowerCase().replace(/[\u2018\u2019]/g,"'").replace(/[?!.]+$/,'').replace(/\s+/g,' ')
    // Time qualifiers ask about the same present capability inventory, not a new action.
    .replace(/ (?:right now|now|currently|at the moment|today)$/,'');
  if(/^(?:what are all of your capabilities|(?:show(?: me)?|list|describe|explain) (?:your|q's|the) (?:full |complete )?capability map|(?:show(?: me)?|list) all (?:of )?(?:your |q's )?capabilities|full capability map)$/.test(q))return 'full';
  if(/^(?:what (?:can you do(?: for me| here)?|can q do|are you capable of|is q capable of|are you able to do|is q able to do|do you do|does q do|are your capabilities|are q's capabilities)|what's q capable of|what're you capable of|how can (?:you|q) help(?: me)?|(?:show(?: me)?|list|describe|explain|tell me about) (?:your|q's) capabilities|(?:show(?: me)?|list) (?:the )?(?:available )?capabilities)$/.test(q))return 'summary';
  return null;
}
export function isCapabilityQuestion(question:string):boolean{return capabilityDetail(question)!==null;}
// Public-safe observations only. Never include identifiers or configuration values.
export type CapabilityRuntime = Readonly<{web:boolean;membership:boolean;evaluation:boolean;experiments:boolean;trackerDigest:boolean;retention:boolean}>;
type Facts = Pick<Actions,'focus'|'improve'|'open'|'feedback'|'build'|'self'|'capabilityRuntime'>;
export const WEB_PUBLIC_ROUTES = ['/', '/llms.txt', '/healthz', '/manifest', '/answer/', '/item/', '/kernel/', '/ask', '/mcp'] as const;
export const DISCORD_EVENTS = ['ClientReady','MessageCreate','MessageDelete','MessageBulkDelete','MessageUpdate','ThreadDelete','ChannelDelete','MessageReactionAdd','MessageReactionRemove','InteractionCreate'] as const;
type ReportKernel = Pick<Kernel,'command'|'model'|'holo'|'commit'>;
export async function capabilityReport(kernel:ReportKernel, community:Decider, actions:Facts, role:'member'|'admin'){
  const commands=[];
  for(const name of Object.keys(COMMAND) as CommandName[]){
    const entry=DISCORD_COMMANDS[name];
    if(!entry)throw new Error('command inventory mismatch');
    const decision=await kernel.command(name,role);
    commands.push({name,summary:entry.summary,source:entry.source,policy:entry.policy,
      wiring:decision!=='allowed'?'not disclosed':entry.effect&&typeof actions[entry.effect]!=='function'?'unavailable':'wired',
      eligibility:decision==='allowed'?'eligible':decision==='not authorized'?'not authorized':'unknown'});
  }
  const runtime=actions.capabilityRuntime?.();
  const state=(fact:boolean|undefined)=>fact===undefined?'unknown':fact?'configured':'not configured';
  const groups=[
    {id:'focus',name:'Live contribution discovery',wiring:typeof actions.focus==='function'?'wired':'unavailable',policy:['DA-38'],source:'host/src/focus-entry.ts',limit:'Public evidence; bounded diagnostic preview, not work assignment or a global ranking.'},
    {id:'community',name:'Community policy decisions',wiring:'wired',policy:['DA-14'],source:'host/src/community.ts',limit:'Signed decision apps; required inputs and applicability must be established.'},
    {id:'knowledge',name:'Knowledge ingestion and search',wiring:'wired',policy:['DA-08','DA-10','DA-13'],source:'host/src/knowledge.ts',limit:'Community, website and configured repository sources; access and freshness checks apply.'},
    {id:'observation',name:'Discord conversation observation',wiring:'conditional',policy:['DA-01','DA-02','DA-03','DA-11'],source:'host/src/adapter/discord.ts',limit:'Eligible channels and messages only; never unrestricted access.'},
    {id:'memory',name:'Context, retention and forgetting',wiring:'conditional',policy:['DA-09','DA-10','DA-21','DA-32','DA-33'],source:'host/src/memory.ts',limit:'Scope and revocation checks apply; no deletion-completeness guarantee.'},
    {id:'retention',name:'Scheduled retention sweep',wiring:state(runtime?.retention),policy:['DA-09'],source:'host/src/main.ts',limit:'Configured schedule does not certify reclamation.'},
    {id:'delivery',name:'Request and answer controls',wiring:'wired',policy:['DA-03','DA-04','DA-05','DA-06','DA-07','DA-12','DA-16','DA-17','DA-18'],source:'host/src/pipeline.ts',limit:'Access, filters, rate limits, evidence and delivery checks; may refuse or remain silent.'},
    {id:'tools',name:'External tool integrations',wiring:'conditional',policy:['DA-19','DA-22','DA-31'],source:'host/src/tools.ts',limit:'Configured, authorized effects only; private tool details withheld.'},
    {id:'web',name:'Web interface',wiring:state(runtime?.web),policy:['DA-22','DA-31','DA-37'],source:'host/src/adapter/web.ts',limit:'Public-source answers, published records, provenance and health; not Discord private memory.'},
    {id:'mcp',name:'Agent-facing MCP interface',wiring:'conditional',policy:['DA-22','DA-31'],source:'host/src/mcp-server.ts',limit:'Public ask/search, status and signed community decisions; deployment dependent.'},
    {id:'membership',name:'Membership administration',wiring:state(runtime?.membership),policy:['DA-23'],source:'host/src/adapter/discord.ts',limit:'Configured rules confirmation, not arbitrary role grants.'},
    {id:'signals',name:'Feedback, corrections and learning',wiring:typeof actions.feedback==='function'?'wired':'unavailable',policy:['DA-26','DA-27','DA-30','DA-32','DA-33'],source:'host/src/improve.ts',limit:'Human signals, consent and trusted-source rules apply.'},
    {id:'filing',name:'Community request filing',wiring:'conditional',policy:['DA-30'],source:'host/src/improve.ts',limit:'Requires consent, support and authorized filing; deployment details withheld.'},
    {id:'evaluation',name:'Evaluation and self-improvement',wiring:state(runtime?.evaluation),policy:['DA-27','DA-28','DA-29','DA-34','DA-35'],source:'host/src/improve.ts',limit:'Evaluated prompt/settings evolution; no autonomous rule or code changes.'},
    {id:'experiments',name:'Approved shadow experiments',wiring:state(runtime?.experiments),policy:['DA-24','DA-25'],source:'host/src/main.ts',limit:'Approved experiments only, never live traffic.'},
    {id:'tracker',name:'Open work tracking and digest',wiring:role==='admin'?state(runtime?.trackerDigest):'not disclosed',policy:['DA-04','DA-36'],source:'host/src/tracker.ts',limit:'Configured server scope; privileged details withheld.'},
    {id:'provenance',name:'Source and execution provenance',wiring:'wired',policy:['DA-10','DA-15','DA-20','DA-39'],source:'host/src/provenance.ts',limit:'Model and signed artifact identity; host qualification remains distinct.'},
  ];
  const surfaces={discord:{events:[...DISCORD_EVENTS]},web:{routes:[...WEB_PUBLIC_ROUTES]},mcp:{tools:MCP_PUBLIC_TOOLS.map(t=>t.name)}};
  const report={type:'uor-agent/capability-report/1',claim:'DA-39',coverage:'registered Discord commands, public interfaces, lifecycle events and declared capability groups; not an exhaustive effective-privilege audit',
    kernel:{model:kernel.model,holo:kernel.holo,commit:kernel.commit},community:{holo:community.pin.holo,commit:community.pin.commit},
    hostRevision:'not independently established',commands,groups,surfaces,
    qualification:'Host wiring and command eligibility only; configuration, operational readiness and per-effect authority are distinct.'};
  return {report,label:labelOf(report)};
}
export function renderCapabilities(value:Awaited<ReturnType<typeof capabilityReport>>):string{
  const {report:r,label}=value;
  const commandLines=r.commands.map(c=>`- /${c.name}: ${c.summary}. ${c.wiring}; ${c.eligibility}. [${c.policy.join(', ')}]`);
  const groupLines=r.groups.map(g=>`- ${g.name}: ${g.wiring}. ${g.limit} [${g.policy.join(', ')}]`);
  return ['**Q capability map**','This is an inventory of registered commands and public capability groups, not a permission grant. "Eligible" is the kernel command check for this caller; further checks apply. "Wired" is host wiring, not a live success guarantee.',
    '**Discord commands**',...commandLines,'**Other capability groups**',...groupLines,
    '**Other public interfaces (deployment dependent)**','Web: '+r.surfaces.web.routes.join(', ')+'.','MCP: '+r.surfaces.mcp.tools.join(', ')+'.','Discord events: '+r.surfaces.discord.events.join(', ')+'.',
    'Provenance (DA-39, measured host claim): kernel model '+r.kernel.model+', holo '+r.kernel.holo+', signed kernel commit '+(r.kernel.commit??'unverified')+'. Community pin '+r.community.commit+', holo '+r.community.holo+'. Host revision '+r.hostRevision+'. Report '+label+'.',
    'Sources: model/ids.toml, CONFORMANCE.md, host/src/capabilities.ts and the named implementation modules. The report does not expose private configuration or independently certify effective privileges. Wiring for ineligible commands is withheld.'].join('\n');
}

/** Plain-language summary and detailed map share the same live report. */
export function summarizeCapabilities(value:Awaited<ReturnType<typeof capabilityReport>>):string{
  const {report:r,label}=value;
  const eligible=(name:CommandName)=>r.commands.some(c=>c.name===name&&c.eligibility==='eligible'&&c.wiring==='wired');
  const status=(id:string)=>r.groups.find(g=>g.id===id)?.wiring;
  const lines=[
    '**What I can do**',
    '- Answer Foundation questions, search sources and explain community decisions.',
    '- Help find contribution opportunities'+(status('focus')==='wired'?' using current public evidence (preview).':' when live discovery is enabled; it is not enabled here.') ,
    status('signals')==='wired'?'- Receive feedback and help with memory and privacy requests.':'- Help with memory and privacy requests. Feedback is not enabled here.',
    '- Support community administration, work tracking and app building when configured and allowed.',
    '- Support web and agent connections, learning and approved background tasks when configured.',
    '',
    'For you, available commands: '+r.commands.filter(c=>eligible(c.name)).map(c=>'/'+c.name).join(', ')+'.',
    'I cannot grant myself permissions or change my own rules. Some requests may be refused. Availability is not proof of successful operation.',
    'Ask “Show me your full capability map” for all commands, limits, and evidence. Report: '+label+'.',
  ];
  return lines.join('\n');
}
