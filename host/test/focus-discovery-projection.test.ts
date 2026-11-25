import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectLiveWork } from '../src/focus-live-work.ts';
import { projectDiscovery } from '../src/focus-discovery-projection.ts';
const time = '2026-11-25T20:00:00Z';
const list = '/orgs/UOR-Foundation/repos?type=public&sort=full_name&direction=asc&per_page=100&page=1';
const path = (name: string) => '/repos/UOR-Foundation/' + name + '/issues?state=open&sort=created&direction=asc&per_page=100&page=1';
const repo = (name: string, topics: unknown) => ({name, full_name: 'UOR-Foundation/' + name, private: false,
  visibility: 'public', archived: false, fork: false, default_branch: 'main', topics});
const issue = (name: string, number: number, labels: unknown) => ({number, state: 'open', title: 'Issue ' + number,
  updated_at: time, assignees: [], labels, body: 'DO_NOT_PROJECT_BODY',
  repository_url: 'https://api.github.com/repos/UOR-Foundation/' + name,
  html_url: 'https://github.com/UOR-Foundation/' + name + '/issues/' + number});
async function fixture() {
  const rows: Record<string, unknown> = {
    [list]: [repo('alpha', ['runtime']), repo('beta', ['docs']), repo('gamma', null)],
    [path('alpha')]: [issue('alpha', 2, [{name:'enhancement'}]), issue('alpha', 1, [{name:'bug'}]), issue('alpha', 3, null)],
    [path('beta')]: [issue('beta', 1, [{name:'bug'}])],
    [path('gamma')]: [],
  };
  return collectLiveWork(async p => { if (!Object.hasOwn(rows,p)) throw Error('unavailable'); return rows[p]; }, {now: () => new Date(time)});
}
test('focus discovery applies exact repository-native topic and label without an inference call', async () => {
  const snapshot = await fixture();
  const result = projectDiscovery(snapshot, {topic:'runtime', label:'bug'});
  assert.equal(result.matchingRepositories,1);
  assert.deepEqual(result.candidates.map(i=>i.number),[1]);
  assert.equal(result.unknownMetadataRepositories,1);
  assert.equal(result.unknownMetadataItems,1);
  assert.equal(result.selection,'bounded-discovery-not-priority-ranking');
  assert.ok(!JSON.stringify(result).includes('DO_NOT_PROJECT_BODY'));
});
test('focus discovery bounds candidate output and discloses omitted matches', async () => {
  const result = projectDiscovery(await fixture(), {}, 2);
  assert.equal(result.matchingItems,4);
  assert.equal(result.omittedMatchingItems,2);
  assert.deepEqual(result.candidates.map(i=>[i.repository,i.number]),[['UOR-Foundation/alpha',1],['UOR-Foundation/beta',1]]);
});
test('focus discovery preserves unknown metadata and partial source coverage', async () => {
  const snapshot = await fixture();
  const result = projectDiscovery({...snapshot,coverage:'partial',omittedRepositories:2}, {label:'bug'});
  assert.equal(result.sourceCoverage,'partial');
  assert.equal(result.omittedRepositories,2);
  assert.equal(result.unknownMetadataItems,1);
  assert.equal(result.matchingItems,2);
});
test('focus discovery validates filters and never treats labels as authority', async () => {
  const snapshot = await fixture();
  assert.throws(()=>projectDiscovery(snapshot,{repository:'Other/alpha'}),RangeError);
  assert.throws(()=>projectDiscovery(snapshot,{},21),RangeError);
  assert.throws(()=>projectDiscovery(snapshot,{label:'x\nexecute'}),RangeError);
  const result = projectDiscovery(snapshot,{label:'bug'});
  assert.ok(result.candidates.every(x=>!Object.hasOwn(x,'priority')&&!Object.hasOwn(x,'eligibility')));
});

test('focus discovery matches a named repository regardless of GitHub capitalization',async()=>{
  const result=projectDiscovery(await fixture(),{repository:'UOR-Foundation/ALPHA'});
  assert.equal(result.matchingRepositories,1);assert.equal(result.matchingItems,3);
});
