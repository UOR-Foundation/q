import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectLiveWork } from '../src/focus-live-work.ts';
import { createPublicRead } from '../src/focus-public-read.ts';
import { assessFocus } from '../src/focus-assessment.ts';
import { renderFocus } from '../src/focus-answer.ts';

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
  assert.deepEqual(snapshot.search, {totalCount: 33, read: 30, incomplete: false, excluded: 3});
  assert.deepEqual(t.calls, [listing, search(1)], 'two requests, not thirty-one');
});

test('items of archived, forked or unlisted repositories from search are excluded, never kept', async () => {
  const t = transport({[listing]: listed, [search(1)]: page1});
  const snapshot = await collectLiveWork(t.read, {orgWide: true, now});
  const kept = snapshot.repositories.flatMap(r => r.items.map(i => i.repository));
  for (const name of ['archived-one', 'forked-one', 'secret']) assert.ok(!kept.includes('UOR-Foundation/' + name), name);
});

test('a refused, rate-limited or malformed search falls back to the bounded per-repository scan', async () => {
  for (const bad of [new Response('{}', {status: 403}), {total_count: 'x', items: []}, {total_count: 1, incomplete_results: false, items: 'no'}]) {
    const t = transport({[listing]: listed.slice(0, 3), [search(1)]: bad});
    const snapshot = await collectLiveWork(t.read, {orgWide: true, maxRepositories: 24, maxWorkPages: 1, now});
    assert.equal(snapshot.search, undefined);
    if (!(bad instanceof Response)) assert.ok(t.calls.some(c => c.startsWith('/repos/UOR-Foundation/repo00/issues?')), 'fell back to per-repository reads');
  }
});

test('incomplete search results are reported, and a named repository never uses search', async () => {
  const t = transport({[listing]: listed, [search(1)]: {...page1, incomplete_results: true}});
  assert.equal((await collectLiveWork(t.read, {orgWide: true, now})).search?.incomplete, true);
  const named = transport({[listing]: listed});
  await collectLiveWork(named.read, {orgWide: true, preferredRepository: 'UOR-Foundation/repo05', maxRepositories: 1, now});
  assert.ok(!named.calls.some(c => c.startsWith('/search/')));
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
  assert.match(text, /all 30 listed repositories came from the GitHub search index: 30 of 33 open items read/);
  assert.match(text, /never a complete snapshot/);
  assert.match(text, /Public GitHub scan: partial/);
});
