import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectPublicInventory, type PublicRead } from '../src/focus-discovery.ts';

const time = '2026-11-25T19:00:00.000Z';
const sha = 'a'.repeat(40);
const treeSha = 'b'.repeat(40);
const blobSha = 'c'.repeat(40);
const commit = { sha, commit: { tree: { sha: treeSha } } };
const repo = (name: string, extras: Record<string, unknown> = {}) => ({
  name, full_name: 'UOR-Foundation/' + name, default_branch: 'main',
  private: false, visibility: 'public', archived: false, fork: false, ...extras,
});
const blob = (path: string, mode = '100644') => ({ path, type: 'blob', mode, sha: blobSha });
const firstPage = '/orgs/UOR-Foundation/repos?type=public&sort=full_name&direction=asc&per_page=100&page=1';
const base = '/repos/UOR-Foundation/q';
function mock(routes: Record<string, unknown>, calls: string[] = []): PublicRead {
  return async (path) => {
    calls.push(path);
    if (!Object.hasOwn(routes, path)) throw new Error('unexpected or unavailable');
    return routes[path];
  };
}
const routes = (entries: unknown[], truncated = false) => ({
  [firstPage]: [repo('q')],
  [base + '/commits/main']: commit,
  [base + '/git/trees/' + treeSha + '?recursive=1']: { sha: treeSha, truncated, tree: entries },
});

test('focus inventory pins the default branch and distinguishes verified presence from absence', async () => {
  const calls: string[] = [];
  const report = await collectPublicInventory(mock(routes([blob('GOVERNANCE.md'), blob('docs/CODEOWNERS'), blob('unrelated.txt')]), calls), { observedAt: time });
  assert.equal(report.enumeration, 'complete');
  assert.equal(report.coverage, 'complete');
  assert.equal(report.repositories[0].commit, sha);
  assert.equal(report.repositories[0].blobs['GOVERNANCE.md'], blobSha);
  assert.equal(report.repositories[0].files['GOVERNANCE.md'], 'present');
  assert.equal(report.repositories[0].files['docs/CODEOWNERS'], 'present');
  assert.equal(report.repositories[0].files['.github/CODEOWNERS'], 'absent');
  assert.deepEqual(calls, [firstPage, base + '/commits/main', base + '/git/trees/' + treeSha + '?recursive=1']);
  assert.ok(!JSON.stringify(report).includes('unrelated.txt'));
});

test('focus inventory truncation never invents absence', async () => {
  const report = await collectPublicInventory(mock(routes([blob('MAINTAINERS.md')], true)), { observedAt: time });
  assert.equal(report.coverage, 'partial');
  assert.equal(report.repositories[0].files['MAINTAINERS.md'], 'present');
  assert.equal(report.repositories[0].files['SECURITY.md'], 'unknown');
  assert.deepEqual(report.repositories[0].failures, ['tree-truncated']);
});

test('focus inventory rejects inaccessible, malformed and duplicate tree entries as negative evidence', async () => {
  const data = routes([blob('GOVERNANCE.md'), blob('GOVERNANCE.md'), null]);
  const report = await collectPublicInventory(mock(data), { observedAt: time });
  assert.equal(report.repositories[0].files['SECURITY.md'], 'unknown');
  assert.equal(report.repositories[0].tree, 'partial');
  assert.equal(report.repositories[0].files['GOVERNANCE.md'], 'unknown');
  assert.equal(report.repositories[0].blobs['GOVERNANCE.md'], undefined);
  assert.ok(report.repositories[0].failures.includes('tree-invalid'));
  const unavailable = await collectPublicInventory(mock({ [firstPage]: [repo('q')], [base + '/commits/main']: commit }), { observedAt: time });
  assert.equal(unavailable.repositories[0].tree, 'unavailable');
  assert.equal(unavailable.repositories[0].files['GOVERNANCE.md'], 'unknown');
  assert.deepEqual(unavailable.repositories[0].failures, ['tree-unavailable']);
});

test('focus inventory does not follow private, foreign, malformed or archived repository records', async () => {
  const calls: string[] = [];
  const data = { ...routes([]), [firstPage]: [
    repo('q'), repo('private-marker', { private: true, visibility: 'private' }),
    repo('foreign-marker', { full_name: 'Other/foreign-marker' }),
    repo('invalid-branch-marker', { default_branch: '..' }),
    repo('archived-marker', { archived: true }), repo('fork-marker', { fork: true }),
  ] };
  const report = await collectPublicInventory(mock(data, calls), { observedAt: time });
  assert.equal(report.coverage, 'partial');
  assert.equal(report.repositories.length, 1);
  assert.equal(report.excluded.nonpublicOrInvalid, 3);
  assert.equal(report.excluded.archivedOrFork, 2);
  assert.ok(!JSON.stringify(report).includes('marker'));
  assert.ok(!calls.some(path => path.includes('marker')));
});

test('focus inventory paginates, respects budget and distinguishes partial coverage from enumeration', async () => {
  const rows = Array.from({ length: 100 }, (_, i) => repo('archived-' + i, { archived: true }));
  const data = { ...routes([]), [firstPage]: rows, [firstPage.replace(/&page=1$/, '&page=2')]: [repo('q'), repo('later')] };
  const calls: string[] = [];
  const report = await collectPublicInventory(mock(data, calls), { observedAt: time, maxRepositories: 1 });
  assert.equal(report.pagesRead, 2);
  assert.equal(report.enumeration, 'complete');
  assert.equal(report.coverage, 'partial');
  assert.equal(report.excluded.budget, 1);
  assert.ok(!calls.some(path => path.includes('/later/')));
  const capped = await collectPublicInventory(mock(data), { observedAt: time, maxPages: 1 });
  assert.equal(capped.enumeration, 'partial');
  assert.ok(capped.failures.includes('page-budget'));
  const interrupted = await collectPublicInventory(mock({ [firstPage]: rows }), { observedAt: time });
  assert.equal(interrupted.enumeration, 'partial');
  assert.ok(interrupted.failures.includes('page-unavailable'));
});

test('focus inventory distinguishes empty complete scope from unavailable first page', async () => {
  assert.equal((await collectPublicInventory(mock({ [firstPage]: [] }), { observedAt: time })).coverage, 'complete');
  const report = await collectPublicInventory(mock({}), { observedAt: time });
  assert.equal(report.coverage, 'unavailable');
  assert.equal(report.pagesRead, 0);
});

test('focus inventory duplicates and invalid refs cannot prove coverage', async () => {
  const report = await collectPublicInventory(mock({ [firstPage]: [repo('q'), repo('Q')], [base + '/commits/main']: { sha: 'bad' } }), { observedAt: time });
  assert.equal(report.excluded.duplicate, 1);
  assert.equal(report.coverage, 'partial');
  assert.equal(report.repositories[0].commit, null);
  assert.deepEqual(report.repositories[0].failures, ['branch-unavailable']);
});

test('focus inventory does not count links or directories as governance documents', async () => {
  const report = await collectPublicInventory(mock(routes([blob('SECURITY.md', '120000'), { path: 'MAINTAINERS.md', type: 'tree', mode: '040000' }])), { observedAt: time });
  assert.equal(report.coverage, 'partial');
  assert.equal(report.repositories[0].files['SECURITY.md'], 'unknown');
  assert.equal(report.repositories[0].files['MAINTAINERS.md'], 'unknown');
});

test('focus inventory refuses malformed budgets and timestamps before reading', async () => {
  const read: PublicRead = async () => assert.fail('must not read');
  await assert.rejects(collectPublicInventory(read, { observedAt: time, maxPages: 0 }), RangeError);
  await assert.rejects(collectPublicInventory(read, { observedAt: time, maxRepositories: 1001 }), RangeError);
  await assert.rejects(collectPublicInventory(read, { observedAt: '2026-02-30T00:00:00.000Z' }), RangeError);
});

test('focus inventory refuses a mismatched tree identity and malformed blob identity', async () => {
  const key = base + '/git/trees/' + treeSha + '?recursive=1';
  const mismatched = await collectPublicInventory(mock({ ...routes([]), [key]: { sha: sha, truncated: false, tree: [blob('GOVERNANCE.md')] } }), { observedAt: time });
  assert.equal(mismatched.repositories[0].files['GOVERNANCE.md'], 'unknown');
  assert.equal(mismatched.coverage, 'partial');
  const invalid = await collectPublicInventory(mock(routes([{ ...blob('GOVERNANCE.md'), sha: 'invalid' }])), { observedAt: time });
  assert.equal(invalid.repositories[0].files['GOVERNANCE.md'], 'unknown');
  assert.deepEqual(invalid.repositories[0].blobs, {});
});
