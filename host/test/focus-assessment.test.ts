import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessFocus } from '../src/focus-assessment.ts';
const stamp='2026-11-25T20:00:00Z';
const listing='/orgs/UOR-Foundation/repos?type=public&sort=full_name&direction=asc&per_page=100&page=1';
const base='/repos/UOR-Foundation/q';
const list=base+'/issues?state=open&sort=created&direction=asc&per_page=100&page=1';
const issue=(number:number,state='open')=>({number,state,title:'Work '+number,updated_at:stamp,assignees:[],
  repository_url:'https://api.github.com/repos/UOR-Foundation/q',html_url:'https://github.com/UOR-Foundation/q/issues/'+number});
const repo={name:'q',full_name:'UOR-Foundation/q',private:false,visibility:'public',archived:false,fork:false,default_branch:'main'};
function fixture(items:unknown[], relations:Record<number,unknown>) {
  const calls:string[]=[];
  const routes:Record<string,unknown>={[listing]:[repo],[list]:items};
  for(const [n,deps] of Object.entries(relations)){
    const path=base+'/issues/'+n;
    routes[path]=issue(Number(n));routes[path+'/dependencies/blocked_by?per_page=100&page=1']=deps;
  }
  const read=async(path:string)=>{calls.push(path);if(!Object.hasOwn(routes,path))throw Error('unavailable');return routes[path];};
  return {read,calls,routes};
}
const now=()=>new Date(stamp);
test('focus assessment constructs live dependency graph and recommends investigating shared prerequisite',async()=>{
  const f=fixture([issue(1),issue(2),issue(3)],{1:[],2:[issue(1)],3:[issue(1)]});
  const r=await assessFocus(f.read,{now});
  assert.equal(r.sourceCoverage,'complete');assert.equal(r.plan.state,'advisory');
  if(r.plan.state!=='advisory')return assert.fail();
  assert.equal(r.plan.coverage,'partial');assert.equal(r.plan.choices.length,0);
  assert.equal(r.diagnosticChoices[0].number,1);assert.equal(r.diagnosticChoices[0].observedDependents,2);
  assert.equal(r.diagnosticChoices[0].action,'verify-prerequisite');
  assert.equal(r.targets.length,3);assert.equal(f.calls.length,11);
});
test('focus assessment does not convert closed dependencies into verified completion',async()=>{
  const f=fixture([issue(2)],{2:[issue(1,'closed')]});
  const r=await assessFocus(f.read,{now});
  assert.equal(r.targets.find(t=>t.number===1)?.observedState,'closed');
  assert.equal(r.diagnosticChoices[0].action,'verify-prerequisite');
  assert.equal(r.diagnosticChoices[0].number,1);
  assert.equal(r.plan.state,'advisory');if(r.plan.state==='advisory')assert.equal(r.plan.choices.length,0);
});
test('focus assessment holds recommendations when live dependency graph is cyclic',async()=>{
  const f=fixture([issue(1),issue(2)],{1:[issue(2)],2:[issue(1)]});
  const r=await assessFocus(f.read,{now});
  assert.deepEqual(r.plan,{state:'invalid',reason:'cycle'});
  assert.deepEqual(r.diagnosticChoices,[]);
});
test('focus assessment exposes shortlist limits and refreshes changed observations',async()=>{
  const f=fixture([issue(1),issue(2),issue(3)],{1:[]});
  f.routes[base+'/issues/1']={...issue(1),updated_at:'2026-11-25T20:01:00Z'};
  const r=await assessFocus(f.read,{now,maxCandidates:1});
  assert.equal(r.projection.omittedMatchingItems,2);
  assert.equal(r.issues[0].observation.state,'unknown');
  assert.equal(r.diagnosticChoices[0].action,'refresh-evidence');
  assert.equal(f.calls.length,5);
});
test('focus assessment supplies exact-head failed-check diagnostics without merge authority',async()=>{
  const head='a'.repeat(40),baseSha='b'.repeat(40);
  const f=fixture([{...issue(7),html_url:'https://github.com/UOR-Foundation/q/pull/7',pull_request:{}}],{});
  f.routes[base+'/pulls/7']={number:7,state:'open',html_url:'https://github.com/UOR-Foundation/q/pull/7',head:{sha:head},
    base:{sha:baseSha,ref:'main',repo:{full_name:'UOR-Foundation/q',private:false}},draft:false,mergeable:true,updated_at:stamp};
  f.routes[base+'/commits/'+head+'/check-runs?filter=latest&per_page=100&page=1']={total_count:1,check_runs:[{id:42,head_sha:head,status:'completed',conclusion:'failure'}]};
  const r=await assessFocus(f.read,{now});
  assert.equal(r.diagnosticChoices[0].action,'inspect-failed-check');
  assert.equal(r.diagnosticChoices[0].head,head);
  assert.deepEqual(r.diagnosticChoices[0].checkIds,[42]);
  assert.equal(r.plan.state,'advisory');if(r.plan.state==='advisory')assert.equal(r.plan.choices.length,0);
});
test('focus assessment refuses cancelled operation and invalid detail budgets',async()=>{
  const ac=new AbortController();ac.abort();
  const r=await assessFocus(async()=>assert.fail('must not read'),{signal:ac.signal,now});
  assert.equal(r.state,'cancelled');assert.deepEqual(r.diagnosticChoices,[]);
  await assert.rejects(assessFocus(async()=>assert.fail('must not read'),{maxCandidates:7}),RangeError);
});
