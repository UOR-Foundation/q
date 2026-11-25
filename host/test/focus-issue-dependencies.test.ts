import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectLiveWork } from '../src/focus-live-work.ts';
import { inspectLiveIssue } from '../src/focus-issue-dependencies.ts';
import { createPublicRead } from '../src/focus-public-read.ts';
const stamp='2026-11-25T20:00:00Z';
const listing='/orgs/UOR-Foundation/repos?type=public&sort=full_name&direction=asc&per_page=100&page=1';
const path='/repos/UOR-Foundation/q/issues/11';
const deps=path+'/dependencies/blocked_by?per_page=100&page=1';
const issue=(repo:string,number:number,state='open')=>({number,state,title:'Work',updated_at:stamp,assignees:[],
  repository_url:'https://api.github.com/repos/'+repo,html_url:'https://github.com/'+repo+'/issues/'+number});
const target=issue('UOR-Foundation/q',11);
const repo=(name:string)=>({name,full_name:'UOR-Foundation/'+name,private:false,visibility:'public',archived:false,fork:false,default_branch:'main'});
async function fixture(dependencies:unknown) {
  const calls:string[]=[];
  const routes:Record<string,unknown>={
    [listing]:[repo('q'),repo('lexlean')],
    ['/repos/UOR-Foundation/q/issues?state=open&sort=created&direction=asc&per_page=100&page=1']:[target],
    ['/repos/UOR-Foundation/lexlean/issues?state=open&sort=created&direction=asc&per_page=100&page=1']:[issue('UOR-Foundation/lexlean',4)],
    [path]:target,[deps]:dependencies,
  };
  const {read}=createPublicRead({fetcher:async url=>{
    const u=new URL(String(url)),key=u.pathname+u.search;calls.push(key);
    return Object.hasOwn(routes,key)?new Response(JSON.stringify(routes[key])):new Response('',{status:404});
  }});
  const snapshot=await collectLiveWork(read,{now:()=>new Date(stamp)});
  return {read,snapshot,calls,item:{repository:'UOR-Foundation/q',number:11}};
}
test('focus issue dependencies preserve live open and closed states without declaring readiness',async()=>{
  const f=await fixture([issue('UOR-Foundation/lexlean',4),issue('UOR-Foundation/q',3,'closed')]);
  const result=await inspectLiveIssue(f.read,f.snapshot,f.item);
  assert.equal(result.state,'observed');
  if(result.state!=='observed')return assert.fail();
  assert.equal(result.coverage,'complete');
  assert.deepEqual(result.dependencies.map(d=>[d.repository,d.number,d.state]),[['UOR-Foundation/lexlean',4,'open'],['UOR-Foundation/q',3,'closed']]);
  assert.equal(result.readiness,'unverified');
  assert.deepEqual(f.calls.slice(-3),[path,deps,path]);
});
test('focus issue dependencies suppress out-of-scope identities and duplicate edges',async()=>{
  const f=await fixture([issue('Other/private-marker',4),issue('UOR-Foundation/unobserved-marker',2),issue('UOR-Foundation/lexlean',4),issue('UOR-Foundation/lexlean',4),target]);
  const result=await inspectLiveIssue(f.read,f.snapshot,f.item);
  assert.equal(result.state,'observed');
  if(result.state!=='observed')return assert.fail();
  assert.equal(result.coverage,'partial');assert.equal(result.unresolved,4);
  assert.equal(result.dependencies.length,1);
  assert.ok(!JSON.stringify(result).includes('marker'));
});
test('focus issue dependencies distinguish unavailable relations from empty relations',async()=>{
  const f=await fixture([]);
  const good=await inspectLiveIssue(f.read,f.snapshot,f.item);
  assert.equal(good.state,'observed');
  if(good.state!=='observed')return assert.fail();
  assert.equal(good.coverage,'complete');assert.deepEqual(good.dependencies,[]);
  const missing=await inspectLiveIssue(async p=>{if(p===path)return target;throw Error('unavailable');},f.snapshot,f.item);
  assert.equal(missing.state,'observed');
  if(missing.state!=='observed')return assert.fail();
  assert.equal(missing.coverage,'unavailable');
  assert.equal(missing.readiness,'unverified');
});
test('focus issue dependencies detect changed issue identity and reject unobserved targets',async()=>{
  const f=await fixture([]);let count=0;
  const moved=await inspectLiveIssue(async p=>p===path?{...target,updated_at:++count===1?stamp:'2026-11-25T20:01:00Z'}:[],f.snapshot,f.item);
  assert.deepEqual(moved,{state:'unknown',reason:'changed'});
  const never=async()=>assert.fail('must not fetch');
  assert.deepEqual(await inspectLiveIssue(never,f.snapshot,{repository:'Other/q',number:11}),{state:'unknown',reason:'not-observed'});
  assert.deepEqual(await inspectLiveIssue(never,f.snapshot,{repository:'UOR-Foundation/q',number:99}),{state:'unknown',reason:'not-observed'});
});
