import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPublicRead } from '../src/focus-public-read.ts';

const list = '/orgs/UOR-Foundation/repos?type=public&sort=full_name&direction=asc&per_page=100&page=1';
const tree = '/repos/UOR-Foundation/q/git/trees/' + 'a'.repeat(40) + '?recursive=1';
const response = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });

test('focus public read uses anonymous fixed-origin GET and no redirects', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const reader = createPublicRead({ fetcher: async (url, init) => {
    calls.push({ url: String(url), init }); return response([]);
  } });
  assert.deepEqual(await reader.read(list), []);
  assert.deepEqual(await reader.read(tree), []);
  assert.deepEqual(await reader.read('/repos/UOR-Foundation/q/commits/release%2Fv1'), []);
  assert.equal(calls[0].url, 'https://api.github.com' + list);
  for (const call of calls) {
    assert.equal(call.init?.method, 'GET');
    assert.equal(call.init?.credentials, 'omit');
    assert.equal(call.init?.redirect, 'error');
    assert.equal(call.init?.body, undefined);
    assert.equal(new Headers(call.init?.headers).has('authorization'), false);
  }
  assert.deepEqual(reader.stats(), { requests: 3, bytes: 6, exhausted: false });
});
test('focus public read rejects arbitrary paths, credentials, foreign repos and ref traversal before fetching', async () => {
  const reader = createPublicRead({ fetcher: async () => assert.fail('must not fetch') });
  for (const path of [
    'https://api.github.com' + list, '//evil.test/a', '/repos/Other/q/commits/main',
    '/repos/UOR-Foundation/q/issues', '/repos/UOR-Foundation/q/commits/..',
    '/repos/UOR-Foundation/q/commits/%2E%2E', '/repos/UOR-Foundation/q/commits/a%2F..%2Fb',
    '/repos/UOR-Foundation/q/commits/a%3Fb', '/repos/UOR-Foundation/q/commits/%252F',
    '/repos/UOR-Foundation/../commits/main', list + '&token=secret',
    list.replace(/page=1$/, 'page=101'), tree.replace('?recursive=1','?recursive=0'),
  ]) await assert.rejects(reader.read(path), /refused/);
  assert.equal(reader.stats().requests, 0);
});
test('focus public read bounds request count and stops after rate limits', async () => {
  const limited = createPublicRead({ maxRequests: 1, fetcher: async () => response([]) });
  await limited.read(list);
  await assert.rejects(limited.read(list), /budget/);
  assert.equal(limited.stats().requests, 1);
  const rate = createPublicRead({ fetcher: async () => new Response('private-marker', { status: 429 }) });
  await assert.rejects(rate.read(list), /^Error: public read unavailable$/);
  await assert.rejects(rate.read(list), /budget/);
  assert.equal(rate.stats().requests, 1);
});
test('focus public read stops oversized streaming responses and aggregate byte consumption', async () => {
  const oversized = createPublicRead({ maxBytes: 4, fetcher: async () => response({ x: 'large' }) });
  await assert.rejects(oversized.read(list));
  assert.equal(oversized.stats().exhausted, true);
  const total = createPublicRead({ maxTotalBytes: 3, fetcher: async () => response([]) });
  await total.read(list);
  await assert.rejects(total.read(list));
  assert.equal(total.stats().exhausted, true);
});
test('focus public read refuses redirects and malformed response bodies', async () => {
  const redirected = createPublicRead({ fetcher: async () => Response.redirect('https://evil.test/', 302) });
  await assert.rejects(redirected.read(list), /unavailable/);
  const broken = createPublicRead({ fetcher: async () => new Response('not json') });
  await assert.rejects(broken.read(list), /unavailable/);
});
test('focus public read respects cancellation before accessing sources', async () => {
  const controller = new AbortController();
  controller.abort();
  const reader = createPublicRead({ signal: controller.signal, fetcher: async () => assert.fail('must not fetch') });
  await assert.rejects(reader.read(list), /budget/);
  assert.equal(reader.stats().requests, 0);
});
test('focus public read refuses concurrent requests and invalid budgets', async () => {
  let resolve!: (value: Response) => void;
  const reader = createPublicRead({ fetcher: async () => new Promise<Response>(r => { resolve = r; }) });
  const pending = reader.read(list);
  await assert.rejects(reader.read(tree), /already active/);
  resolve(response([]));
  await pending;
  assert.equal(reader.stats().requests, 1);
  assert.throws(() => createPublicRead({ maxRequests: 0 }), RangeError);
  assert.throws(() => createPublicRead({ maxBytes: Infinity }), RangeError);
});
