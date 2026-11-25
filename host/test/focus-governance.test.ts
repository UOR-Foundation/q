import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { collectPublicInventory, type PublicRead } from '../src/focus-discovery.ts';
import { collectGovernanceSources } from '../src/focus-governance.ts';
import { validateStrategySelection } from '../src/focus-strategy.ts';
import { createPublicRead } from '../src/focus-public-read.ts';

const sha = 'a'.repeat(40), tree = 'b'.repeat(40);
const index = 'The single canonical architecture owner register is [Owner register](docs/README.md).';
const routes = new Map<string, unknown>();
const listing = '/orgs/UOR-Foundation/repos?type=public&sort=full_name&direction=asc&per_page=100&page=1';
const repo = (name: string) => ({name, full_name: 'UOR-Foundation/' + name, default_branch: 'main',
  private: false, visibility: 'public', archived: false, fork: false});
function addRepo(name: string, docs: Record<string, string>) {
  const base = '/repos/UOR-Foundation/' + name;
  routes.set(base + '/commits/main', {sha, commit: {tree: {sha: tree}}});
  const entries = Object.entries(docs).map(([path, text]) => {
    const data = Buffer.from(text);
    const blob = createHash('sha1').update('blob ' + data.length + '\0').update(data).digest('hex');
    routes.set(base + '/git/blobs/' + blob, {sha: blob, encoding: 'base64', size: data.length, content: data.toString('base64')});
    return {path, type: 'blob', mode: '100644', sha: blob};
  });
  routes.set(base + '/git/trees/' + tree + '?recursive=1', {sha: tree, truncated: false, tree: entries});
}
async function fixture() {
  routes.clear();
  routes.set(listing, [repo('.github'), repo('q')]);
  addRepo('.github', {'governance/GOVERNANCE.md': 'Foundation baseline', 'MAINTAINERS.md': 'Evidence directory'});
  addRepo('q', {'GOVERNANCE.md': 'Local declaration', 'ARCHITECTURE_INDEX.md': index, 'docs/README.md': 'Owner register',
    'docs/CODEOWNERS': '* @example', '.qortara/ledger.jsonl': 'fixture journal'});
  const calls: string[] = [];
  const transport = createPublicRead({fetcher: async url => {
    const parsed = new URL(String(url));
    const path = parsed.pathname + parsed.search;
    calls.push(path);
    if (!routes.has(path)) return new Response('', {status: 404});
    return new Response(JSON.stringify(routes.get(path)));
  }});
  const inventory = await collectPublicInventory(transport.read, {observedAt: '2026-11-25T19:00:00.000Z'});
  return {inventory, read: transport.read, calls};
}

test('focus governance strategy connects anonymous transport, pinned inventory, and bound documents', async () => {
  const {inventory, read, calls} = await fixture();
  const selected = validateStrategySelection('{"intent":"governance"}', new Set());
  const result = await collectGovernanceSources(read, inventory, selected, 'UOR-Foundation/q');
  assert.equal(result.state, 'collected');
  if (result.state !== 'collected') return assert.fail();
  assert.equal(result.commit, sha);
  assert.equal(result.inventoryCoverage, 'complete');
  assert.deepEqual(result.codeowners, {state: 'candidate', path: 'docs/CODEOWNERS'});
  assert.deepEqual(result.architecture, {state: 'candidate', path: 'docs/README.md'});
  assert.ok(result.sources.some(x => x.path === 'governance/GOVERNANCE.md' && x.evidence.state === 'bound'));
  assert.ok(result.sources.some(x => x.path === 'docs/README.md' && x.evidence.state === 'bound'));
  assert.ok(result.sources.some(x => x.path === 'SECURITY.md' && x.evidence.state === 'absent'));
  assert.ok(result.unresolved.includes('authority-and-effective-controls-unverified'));
  assert.ok(!result.sources.some(x => x.path === '.qortara/ledger.jsonl'));
  assert.equal(calls.filter(x => x.includes('/git/blobs/')).length, 6);
});
test('focus impact strategy collects architecture facts without fetching ownership records', async () => {
  const {inventory, read} = await fixture();
  const result = await collectGovernanceSources(read, inventory, validateStrategySelection('{"intent":"impact"}', new Set()), 'UOR-Foundation/q');
  assert.equal(result.state, 'collected');
  if (result.state !== 'collected') return assert.fail();
  assert.deepEqual(result.sources.map(x => x.path), ['ARCHITECTURE_INDEX.md', 'docs/README.md']);
  assert.ok(result.unresolved.includes('dependency-edges-unverified'));
});
test('focus governance does not expand scope when repository or route is unknown', async () => {
  const {inventory} = await fixture();
  const never: PublicRead = async () => assert.fail('must not read');
  const route = validateStrategySelection('{"intent":"responsibility"}', new Set());
  assert.deepEqual(await collectGovernanceSources(never, inventory, route, 'Other/q'), {state: 'not-collected', reason: 'target-unobserved'});
  assert.deepEqual(await collectGovernanceSources(never, inventory, validateStrategySelection('{"intent":"focus"}', new Set()), 'UOR-Foundation/q'), {state: 'not-collected', reason: 'unsupported-route'});
  assert.deepEqual(await collectGovernanceSources(never, {...inventory, repositories: [...inventory.repositories, inventory.repositories[1]]}, route, 'UOR-Foundation/q'), {state: 'not-collected', reason: 'target-ambiguous'});
});
test('focus governance preserves partial inventory and unavailable source evidence', async () => {
  const {inventory} = await fixture();
  const selected = validateStrategySelection('{"intent":"governance"}', new Set());
  const result = await collectGovernanceSources(async () => {throw Error('unavailable');}, {...inventory, coverage: 'partial'}, selected, 'UOR-Foundation/q');
  assert.equal(result.state, 'collected');
  if (result.state !== 'collected') return assert.fail();
  assert.ok(result.unresolved.includes('inventory-coverage'));
  assert.ok(result.unresolved.includes('source-unavailable'));
  assert.ok(result.unresolved.includes('architecture-register-unresolved'));
  assert.ok(result.unresolved.includes('codeowners-unresolved'));
  assert.ok(result.sources.every(x => x.evidence.state !== 'bound'));
});
