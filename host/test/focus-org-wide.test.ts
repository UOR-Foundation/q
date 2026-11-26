import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectLiveWork } from '../src/focus-live-work.ts';
import { createPublicRead } from '../src/focus-public-read.ts';
import { assessFocus } from '../src/focus-assessment.ts';
import { renderFocus } from '../src/focus-answer.ts';
import { runFocus } from '../src/focus-entry.ts';
import { Kernel } from '../src/kernel.ts';
import { fileURLToPath } from 'node:url';

const listing = '/orgs/UOR-Foundation/repos?type=public&sort=full_name&direction=asc&per_page=100&page=1';
const search = (page: number) => '/search/issues?q=org%3AUOR-Foundation+is%3Aopen+archived%3Afalse&sort=created&order=asc&per_page=100&page=' + page;
const stamp = '2026-11-25T20:00:00Z';
const now = () => new Date(stamp);
const repo = (name: string, extras: Record<string, unknown> = {}) => ({name, full_name: 'UOR-Foundation/' + name,
  private: false, visibility: 'public', archived: false, fork: false, default_branch: 'main', ...extras});
const hit = (name: string, number: number, extra: Record<string, unknown> = {}) => ({
  number, state: 'open', title: 'Work ' + number, updated_at: stamp, assignees: [],
  html_url: 'https://github.com/UOR-Foundation/' + name + '/issues/' + number,
  repository_url: 'https://api.github.com/repos/UOR-Foundation/' + name, ...extra });
// Thirty active public repositories: more than the 24 the per-repository scan reads.
const names = Array.from({length: 30}, (_, i) => 'repo' + String(i).padStart(2, '0'));
function transport(data: Record<string, unknown>) {
  const calls: string[] = [];
  const reader = createPublicRead({fetcher: async url => {
    const u = new URL(String(url));
    const key = u.pathname + u.search;
    calls.push(key);
    const value = data[key];
    if (value === undefined) return new Response('{}', {status: 404});
    if (value instanceof Response) return value;
    return new Response(JSON.stringify(value), {status: 200});
  }});
  return {...reader, calls};
}
const listed = [...names.map(n => repo(n)), repo('archived-one', {archived: true}), repo('forked-one', {fork: true})];
const page1 = {total_count: 33, incomplete_results: false, items: [
  ...names.map((n, i) => hit(n, i + 1)),
  hit('archived-one', 1), hit('forked-one', 1),
  { ...hit('secret', 1), repository_url: 'https://api.github.com/repos/UOR-Foundation/secret' },
]};

test('org-wide search covers every listed active repository, beyond the per-repository cap', async () => {
  const t = transport({[listing]: listed, [search(1)]: page1});
  const snapshot = await collectLiveWork(t.read, {orgWide: true, maxRepositories: 24, maxWorkPages: 1, now});
  assert.equal(snapshot.repositories.length, 30);
  assert.equal(snapshot.omittedRepositories, 0);
  assert.ok(snapshot.repositories.every(r => r.items.length === 1 && r.coverage === 'partial'));
  assert.equal(snapshot.coverage, 'partial', 'a search index is never a complete snapshot');
  assert.deepEqual(snapshot.search, {state: 'read', pages: 1, totalCount: 33, read: 30, incomplete: false, excluded: 3});
  assert.deepEqual(t.calls, [listing, search(1)], 'two requests, not thirty-one');
});

test('items of archived, forked or unlisted repositories from search are excluded, never kept', async () => {
  const t = transport({[listing]: listed, [search(1)]: page1});
  const snapshot = await collectLiveWork(t.read, {orgWide: true, now});
  const kept = snapshot.repositories.flatMap(r => r.items.map(i => i.repository));
  for (const name of ['archived-one', 'forked-one', 'secret']) assert.ok(!kept.includes('UOR-Foundation/' + name), name);
});

// 250 open items over three pages; repositories late00..late04 appear only on the third page.
const lateNames = Array.from({length: 5}, (_, i) => 'late0' + i);
const big = [...names, ...lateNames];
const bigListing = big.map(n => repo(n));
const bigPages = [1, 2, 3].map(page => ({ total_count: 250, incomplete_results: false,
  items: page < 3 ? Array.from({length: 100}, (_, i) => hit(names[i % names.length], page * 1000 + i))
                  : Array.from({length: 50}, (_, i) => hit(lateNames[i % lateNames.length], 3000 + i)) }));

test('more than 100 records: later pages are read within the search budget, and the cap is reported, not hidden', async () => {
  const data = {[listing]: bigListing, [search(1)]: bigPages[0], [search(2)]: bigPages[1], [search(3)]: bigPages[2]};
  const whole = await collectLiveWork(transport(data).read, {orgWide: true, maxSearchPages: 3, maxWorkPages: 1, now});
  assert.equal(whole.search?.state, 'read');
  assert.equal(whole.search?.read, 250);
  for (const name of lateNames) assert.ok(whole.repositories.find(r => r.repository === 'UOR-Foundation/' + name)!.items.length > 0, name);
  const capped = transport(data);
  const short = await collectLiveWork(capped.read, {orgWide: true, maxSearchPages: 2, maxWorkPages: 1, now});
  assert.deepEqual(capped.calls, [listing, search(1), search(2)]);
  assert.equal(short.search?.state, 'capped');
  assert.equal(short.search?.read, 200);
  // A repository with no returned hits under a capped search is unknown, never presented as covered.
  for (const name of lateNames) {
    const r = short.repositories.find(r => r.repository === 'UOR-Foundation/' + name)!;
    assert.equal(r.items.length, 0); assert.equal(r.coverage, 'unavailable', name);
  }
  const text = renderFocus(await assessFocus(transport(data).read, {orgWide: true, maxSearchPages: 2, maxWorkPages: 1, maxCandidates: 4, now}));
  assert.match(text, /200 of 250 open items read from 2 pages; stopped at the 2-page budget/);
  assert.match(text, /a repository with no returned items is unknown, not idle/);
});

test('a rate-limited or refused search is reported as unavailable and never claims a fallback the transport cannot make', async () => {
  for (const status of [403, 429]) {
    const t = transport({[listing]: listed, [search(1)]: new Response('{}', {status, headers: {'x-ratelimit-remaining': '0'}})});
    const snapshot = await collectLiveWork(t.read, {orgWide: true, maxSearchPages: 7, maxRepositories: 24, maxWorkPages: 1, now});
    assert.deepEqual(t.calls, [listing, search(1)], 'no per-repository request after the hard stop');
    assert.equal(snapshot.search?.state, 'unavailable');
    assert.equal(snapshot.coverage, 'unavailable');
    assert.ok(snapshot.repositories.every(r => r.items.length === 0 && r.coverage === 'unavailable'));
    const text = renderFocus(await assessFocus(transport({[listing]: listed, [search(1)]: new Response('{}', {status})}).read, {orgWide: true, maxSearchPages: 7, maxCandidates: 4, now}));
    assert.match(text, /could not be read \(refused, rate-limited or unreachable\); no open work was read/);
    assert.doesNotMatch(text, /read separately instead/);
  }
});

test('a later-page failure keeps what was read, stops, and says so', async () => {
  for (const second of [new Response('{}', {status: 403}), {total_count: 'bad', items: []}]) {
    const t = transport({[listing]: bigListing, [search(1)]: bigPages[0], [search(2)]: second});
    const snapshot = await collectLiveWork(t.read, {orgWide: true, maxSearchPages: 7, maxWorkPages: 1, now});
    assert.deepEqual(t.calls, [listing, search(1), search(2)]);
    assert.equal(snapshot.search?.state, 'interrupted');
    assert.equal(snapshot.search?.read, 100);
    assert.equal(snapshot.repositories.find(r => r.repository === 'UOR-Foundation/late00')!.coverage, 'unavailable');
  }
});

test('only a malformed first page, with the transport still able to read, falls back to the per-repository scan', async () => {
  const t = transport({[listing]: listed.slice(0, 3), [search(1)]: {total_count: 'x', items: []}});
  const snapshot = await collectLiveWork(t.read, {orgWide: true, maxSearchPages: 7, maxRepositories: 24, maxWorkPages: 1, now});
  assert.equal(snapshot.search?.state, 'fallback');
  assert.ok(t.calls.includes('/repos/UOR-Foundation/repo00/issues?state=open&sort=created&direction=asc&per_page=100&page=1'), 'a real fallback request was sent');
});

test('production Focus reads seven search pages and still has request capacity for candidate details', async () => {
  const kernel = await Kernel.open(fileURLToPath(new URL('../../app/.prism/build/q.holo', import.meta.url)));
  const pages = Array.from({length: 7}, (_, p) => ({ total_count: 700, incomplete_results: false,
    items: Array.from({length: 100}, (_, i) => hit(names[(p * 100 + i) % names.length], p * 100 + i + 1)) }));
  const data: Record<string, unknown> = {[listing]: listed, ...Object.fromEntries(pages.map((page, i) => [search(i + 1), page]))};
  const calls: string[] = [];
  const result = await runFocus(kernel, {async complete() { return '{"intent":"focus"}'; }}, 'What should I work on next?',
    {admitted: true, community: 'not-applicable', scope: 'public'}, {fetcher: async url => {
      const u = new URL(String(url)); const key = u.pathname + u.search; calls.push(key);
      return key in data ? new Response(JSON.stringify(data[key])) : new Response('{}', {status: 404});
    }});
  assert.equal(result.kind, 'assessment');
  assert.deepEqual(calls.filter(c => c.startsWith('/search/')), pages.map((_, i) => search(i + 1)));
  const after = calls.slice(calls.indexOf(search(7)) + 1);
  assert.ok(after.length >= 1, 'candidate details were still read after the search');
  assert.ok(calls.length <= 40);
  if(result.kind!=='assessment')return assert.fail();
  assert.equal(result.data.transport?.requests,calls.length);
  assert.ok((result.data.transport?.bytes??0)>0);
  assert.ok((result.data.transport?.elapsedMs??-1)>=0);
  assert.match(renderFocus(result.data),/Public collection: \d+ requests; \d+ response bytes; \d+ ms/);
});

test('incomplete search results are reported, and a named repository never uses search', async () => {
  const t = transport({[listing]: listed, [search(1)]: {...page1, incomplete_results: true}});
  assert.equal((await collectLiveWork(t.read, {orgWide: true, now})).search?.incomplete, true);
  const named = transport({[listing]: listed});
  await collectLiveWork(named.read, {orgWide: true, preferredRepository: 'UOR-Foundation/repo05', maxRepositories: 1, now});
  assert.ok(!named.calls.some(c => c.startsWith('/search/')));
});

test('search totals, duplicate rows and no-hit repositories cannot overstate coverage', async () => {
  const listed = [repo('alpha'), repo('beta')];
  for (const rows of [
    {total_count: 3, incomplete_results: false, items: [hit('alpha',1)]},
    {total_count: 2, incomplete_results: false, items: [hit('alpha',1),hit('alpha',1)]},
  ]) {
    const data = {[listing]:listed,[search(1)]:rows};
    const r = await collectLiveWork(transport(data).read,{orgWide:true,now});
    assert.equal(r.search?.state,'inconsistent');
    assert.equal(r.repositories[1].coverage,'unavailable');
    assert.equal(r.coverage,'partial');
    const text = renderFocus(await assessFocus(transport(data).read,{orgWide:true,now}));
    assert.match(text,/coverage is uncertain/);
    assert.doesNotMatch(text,/pagination ended at the reported total/);
  }
  const complete = await collectLiveWork(transport({[listing]:listed,[search(1)]:{total_count:1,incomplete_results:false,items:[hit('alpha',1)]}}).read,{orgWide:true,now});
  assert.equal(complete.search?.state,'read');
  assert.equal(complete.repositories[1].coverage,'unavailable');
});

test('the transport admits exactly the one organization-wide query', async () => {
  const {read} = createPublicRead({fetcher: async () => assert.fail('must not fetch')});
  for (const path of [
    '/search/issues?q=org%3AOther+is%3Aopen+archived%3Afalse&sort=created&order=asc&per_page=100&page=1',
    '/search/issues?q=org%3AUOR-Foundation+is%3Aclosed+archived%3Afalse&sort=created&order=asc&per_page=100&page=1',
    '/search/issues?q=org%3AUOR-Foundation+is%3Aopen+archived%3Afalse&sort=created&order=asc&per_page=100&page=11',
    '/search/issues?q=org%3AUOR-Foundation+is%3Aopen+archived%3Afalse+author%3Asomeone&sort=created&order=asc&per_page=100&page=1',
    '/search/code?q=org%3AUOR-Foundation',
  ]) await assert.rejects(read(path), /refused/, path);
});

test('the rendered assessment says where open work came from and never claims completeness', async () => {
  const t = transport({[listing]: listed, [search(1)]: page1});
  const data = await assessFocus(t.read, {orgWide: true, maxRepositories: 24, maxWorkPages: 1, maxCandidates: 4, now});
  const text = renderFocus(data);
  assert.match(text, /the 30 listed repositories came from the GitHub search index: 30 of 33 open items read from 1 page; pagination ended at the reported total; 3 rows excluded from scope/);
  assert.match(text, /never a complete snapshot/);
  assert.match(text, /Public GitHub scan: partial/);
});
