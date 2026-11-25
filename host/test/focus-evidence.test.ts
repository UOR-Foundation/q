import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { collectPublicInventory, type PublicRead } from '../src/focus-discovery.ts';
import { architectureRegisterHint, codeownersSource, readPublicEvidence } from '../src/focus-evidence.ts';

const commit = 'a'.repeat(40), tree = 'b'.repeat(40);
const indexText = '# Architecture index\n\nThe single canonical architecture owner register is [Owner register](docs/README.md).\n';
const payload = (text: string | Buffer) => {
  const bytes = Buffer.from(text);
  const sha = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
  return { sha, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') };
};
const base = '/repos/UOR-Foundation/q';
async function fixture(entries: Record<string, ReturnType<typeof payload>>, truncated = false) {
  const calls: string[] = [];
  const read: PublicRead = async path => {
    calls.push(path);
    if (path.startsWith('/orgs/')) return [{ name: 'q', full_name: 'UOR-Foundation/q', default_branch: 'main', private: false, visibility: 'public', archived: false, fork: false }];
    if (path === base + '/commits/main') return { sha: commit, commit: { tree: { sha: tree } } };
    if (path === base + '/git/trees/' + tree + '?recursive=1') return {
      sha: tree, truncated, tree: Object.entries(entries).map(([path, p]) => ({ path, sha: p.sha, type: 'blob', mode: '100644' })),
    };
    for (const p of Object.values(entries)) if (path === base + '/git/blobs/' + p.sha) return p;
    throw Error('not available');
  };
  const result = await collectPublicInventory(read, { observedAt: '2026-11-25T19:00:00.000Z' });
  return { repo: result.repositories[0], read, calls };
}

test('focus evidence verifies actual Git blob bytes and produces a revision-bound citation', async () => {
  const p = payload(indexText);
  const { repo, read, calls } = await fixture({ 'ARCHITECTURE_INDEX.md': p, 'docs/README.md': payload('owner register') });
  const source = await readPublicEvidence(read, repo, 'ARCHITECTURE_INDEX.md');
  assert.equal(source.state, 'bound');
  if (source.state !== 'bound') return assert.fail();
  assert.equal(source.blob, p.sha);
  assert.equal(source.text, indexText);
  assert.equal(source.url, 'https://github.com/UOR-Foundation/q/blob/' + commit + '/ARCHITECTURE_INDEX.md');
  assert.deepEqual(architectureRegisterHint(source), { state: 'candidate', path: 'docs/README.md' });
  assert.ok(calls.includes(base + '/git/blobs/' + p.sha));
  assert.equal(calls.filter(x => x.includes('/git/blobs/')).length, 1);
});

test('focus evidence refuses substituted bytes even when response claims the expected identity', async () => {
  const p = payload(indexText);
  const { repo } = await fixture({ 'ARCHITECTURE_INDEX.md': p });
  const substituted = payload('replacement');
  assert.deepEqual(await readPublicEvidence(async () => ({ ...substituted, sha: p.sha }), repo, 'ARCHITECTURE_INDEX.md'),
    { state: 'unknown', reason: 'invalid-binding' });
});

test('focus evidence refuses oversized, malformed and non-UTF8 content', async () => {
  const { repo } = await fixture({ 'SECURITY.md': payload('test') });
  const p = payload('test');
  for (const raw of [{ ...p, size: 200000 }, { ...p, content: '%%%%' }, { ...p, content: p.content + '=' }]) {
    assert.deepEqual(await readPublicEvidence(async () => raw, repo, 'SECURITY.md'), { state: 'unknown', reason: 'invalid-content' });
  }
  const invalid = await fixture({ 'SECURITY.md': payload(Buffer.from([0xff])) });
  assert.deepEqual(await readPublicEvidence(invalid.read, invalid.repo, 'SECURITY.md'), { state: 'unknown', reason: 'invalid-content' });
});

test('focus evidence does not fetch ledger content, unknown paths or foreign repository records', async () => {
  const { repo } = await fixture({ '.qortara/ledger.jsonl': payload('fixture only'), 'GOVERNANCE.md': payload('example') });
  const noRead: PublicRead = async () => assert.fail('must not fetch');
  assert.deepEqual(await readPublicEvidence(noRead, repo, '.qortara/ledger.jsonl'), { state: 'unknown', reason: 'invalid-binding' });
  assert.deepEqual(await readPublicEvidence(noRead, { ...repo, repository: 'Other/q' }, 'GOVERNANCE.md'), { state: 'unknown', reason: 'invalid-binding' });
  assert.deepEqual(await readPublicEvidence(noRead, repo, 'SECURITY.md'), { state: 'absent', reason: 'complete-tree-absence' });
  const partial = await fixture({}, true);
  assert.deepEqual(await readPublicEvidence(noRead, partial.repo, 'SECURITY.md'), { state: 'unknown', reason: 'not-observed' });
});

test('focus evidence selects a CODEOWNERS source only when higher-precedence paths are known', async () => {
  const all = await fixture({ '.github/CODEOWNERS': payload('* @example'), 'CODEOWNERS': payload('* @other'), 'docs/CODEOWNERS': payload('* @third') });
  assert.deepEqual(codeownersSource(all.repo), { state: 'candidate', path: '.github/CODEOWNERS' });
  const lower = await fixture({ 'docs/CODEOWNERS': payload('* @example') });
  assert.deepEqual(codeownersSource(lower.repo), { state: 'candidate', path: 'docs/CODEOWNERS' });
  const partial = await fixture({ 'docs/CODEOWNERS': payload('* @example') }, true);
  assert.deepEqual(codeownersSource(partial.repo), { state: 'unknown' });
  const none = await fixture({});
  assert.deepEqual(codeownersSource(none.repo), { state: 'absent' });
});

test('focus architecture navigation is a candidate only and refuses ambiguous or off-scope references', async () => {
  for (const [text, expected] of [
    [indexText.replace('docs/README.md', 'docs/architecture/owners.md'), { state: 'candidate', path: 'docs/architecture/owners.md' }],
    [indexText.replace('docs/README.md', 'https://example.test/README.md'), { state: 'unknown' }],
    [indexText.replace('docs/README.md', 'docs/../private.md'), { state: 'unknown' }],
    [indexText + '\n[Another](docs/other.md)', { state: 'unknown' }],
    ['\x60\x60\x60md\n' + indexText + '\x60\x60\x60', { state: 'unknown' }],
    ['<!--\n' + indexText + '-->', { state: 'unknown' }],
  ] as const) {
    const { repo, read } = await fixture({ 'ARCHITECTURE_INDEX.md': payload(text) });
    assert.deepEqual(architectureRegisterHint(await readPublicEvidence(read, repo, 'ARCHITECTURE_INDEX.md')), expected);
  }
});
