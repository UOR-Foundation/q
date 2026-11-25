import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectLiveWork, inspectLivePull } from '../src/focus-live-work.ts';
import { createPublicRead } from '../src/focus-public-read.ts';

const listing = '/orgs/UOR-Foundation/repos?type=public&sort=full_name&direction=asc&per_page=100&page=1';
const base = '/repos/UOR-Foundation/q';
const issues = base + '/issues?state=open&sort=created&direction=asc&per_page=100&page=1';
const pr = base + '/pulls/7';
const head = 'a'.repeat(40), other = 'b'.repeat(40);
const checks = base + '/commits/' + head + '/check-runs?filter=latest&per_page=100&page=1';
const stamp = '2026-11-25T20:00:00Z';
const now = () => new Date(stamp);
const repo = (name: string, extras: Record<string, unknown> = {}) => ({name, full_name: 'UOR-Foundation/' + name,
  private: false, visibility: 'public', archived: false, fork: false, default_branch: 'main', ...extras});
const item = (number: number, isPull = false, extra: Record<string, unknown> = {}) => ({
  number, state: 'open', title: 'Work ' + number, updated_at: stamp, assignees: [],
  html_url: 'https://github.com/UOR-Foundation/q/' + (isPull ? 'pull/' : 'issues/') + number,
  repository_url: 'https://api.github.com/repos/UOR-Foundation/q',
  ...(isPull ? {pull_request: {}} : {}), ...extra,
});
const detail = (h = head) => ({number: 7, state: 'open', html_url: 'https://github.com/UOR-Foundation/q/pull/7',
  head: {sha: h}, base: {sha: other, ref: 'main', repo: {full_name: 'UOR-Foundation/q', private: false}},
  draft: false, mergeable: true, updated_at: stamp});
const run = (h = head) => ({id: 1, head_sha: h, status: 'completed', conclusion: 'success'});
function transport(data: Record<string, unknown>) {
  const calls: string[] = [];
  const reader = createPublicRead({fetcher: async url => {
    const u = new URL(String(url));
    const key = u.pathname + u.search;
    calls.push(key);
    return Object.hasOwn(data, key) ? new Response(JSON.stringify(data[key])) : new Response('', {status: 404});
  }});
  return {...reader, calls};
}
test('focus live work fetches open issues and pulls from current repository listings without tree reads', async () => {
  const t = transport({[listing]: [repo('q'), repo('archived', {archived: true})], [issues]: [item(3), item(7,true)]});
  const snapshot = await collectLiveWork(t.read, {now});
  assert.equal(snapshot.coverage, 'complete');
  assert.equal(snapshot.startedAt, now().toISOString());
  assert.deepEqual(snapshot.repositories[0].items.map(i => [i.number,i.kind]), [[3,'issue'],[7,'pull']]);
  assert.deepEqual(t.calls, [listing,issues]);
  assert.ok(!JSON.stringify(snapshot).includes('archived'));
});
test('focus live work preserves incomplete collection and rejects private or foreign data', async () => {
  const t = transport({[listing]: [repo('q'),repo('private-marker',{private:true,visibility:'private'}),repo('later')],
    [issues]: [item(3),item(4,false,{repository_url:'https://api.github.com/repos/Other/q'}),item(3)]});
  const snapshot = await collectLiveWork(t.read,{now});
  assert.equal(snapshot.coverage,'partial');
  assert.equal(snapshot.repositories[0].items.length,1);
  assert.equal(snapshot.repositories[0].coverage,'partial');
  assert.equal(snapshot.repositories[1].coverage,'unavailable');
  assert.ok(!JSON.stringify(snapshot).includes('private-marker'));
  assert.ok(!t.calls.some(x=>x.includes('private-marker')));
});
test('focus live work paginates bounded collections and never treats capped coverage as complete', async () => {
  const rows = Array.from({length:100},(_,i)=>item(i+1));
  const t = transport({[listing]:[repo('q')],[issues]:rows,[issues.replace(/&page=1$/,'&page=2')]:[item(101)]});
  assert.equal((await collectLiveWork(t.read,{now,maxWorkPages:1})).coverage,'partial');
  const fresh = await collectLiveWork(t.read,{now,maxWorkPages:2});
  assert.equal(fresh.coverage,'complete');
  assert.equal(fresh.repositories[0].items.length,101);
});
test('focus live pull binds checks to exact current head and base, not merge authority', async () => {
  const t = transport({[listing]:[repo('q')],[issues]:[item(7,true)],[pr]:detail(),[checks]:{total_count:1,check_runs:[run()]}});
  const snapshot = await collectLiveWork(t.read,{now});
  const result = await inspectLivePull(t.read,snapshot,'UOR-Foundation/q',7,{now});
  assert.equal(result.state,'observed');
  if(result.state!=='observed') return assert.fail();
  assert.equal(result.head,head);
  assert.equal(result.base,other);
  assert.equal(result.checks.coverage,'complete');
  assert.equal(result.reviewAndRequiredControls,'unverified');
  assert.deepEqual(t.calls.slice(-3),[pr,checks,pr]);
});
test('focus live pull refuses wrong-head checks and changes during qualification', async () => {
  const t = transport({[listing]:[repo('q')],[issues]:[item(7,true)],[pr]:detail(),[checks]:{total_count:1,check_runs:[run(other)]}});
  const snapshot = await collectLiveWork(t.read,{now});
  const result = await inspectLivePull(t.read,snapshot,'UOR-Foundation/q',7,{now});
  assert.equal(result.state,'observed');
  if(result.state!=='observed') return assert.fail();
  assert.equal(result.checks.coverage,'partial');
  assert.deepEqual(result.checks.runs,[]);
  let reads=0;
  const moved = await inspectLivePull(async path=>path===pr ? detail(++reads===1?head:other) : {total_count:1,check_runs:[run()]},snapshot,'UOR-Foundation/q',7,{now});
  assert.deepEqual(moved,{state:'unknown',reason:'changed'});
});
test('focus live pull cannot fetch an unobserved or foreign candidate', async () => {
  const t = transport({[listing]:[repo('q')],[issues]:[item(3)]});
  const snapshot = await collectLiveWork(t.read,{now});
  const never = async()=>assert.fail('must not fetch');
  assert.deepEqual(await inspectLivePull(never,snapshot,'UOR-Foundation/q',3),{state:'unknown',reason:'not-observed'});
  assert.deepEqual(await inspectLivePull(never,snapshot,'Other/q',7),{state:'unknown',reason:'not-observed'});
});
