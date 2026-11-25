import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recommendWork, type Task, type TaskSnapshot } from '../src/focus-task-plan.ts';

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id, kind: 'action', state: 'todo', eligibility: 'ready', dependsOn: [],
  obligation: 'discretionary', effortMinutes: 30, value: 3, ...extra,
});
function run(tasks: Task[], extra: Partial<TaskSnapshot> = {}) {
  const result = recommendWork({ tasks, coverage: 'complete', ...extra });
  assert.equal(result.state, 'advisory');
  if (result.state !== 'advisory') throw Error('unexpected invalid graph');
  return result;
}

test('focus task plan prioritizes a prerequisite that unlocks multiple downstream deliverables', () => {
  const result = run([
    task('upstream'), task('downstream-a', { dependsOn: ['upstream'] }),
    task('downstream-b', { dependsOn: ['upstream'] }), task('cosmetic', { value: 2, effortMinutes: 5 }),
  ]);
  assert.equal(result.choices[0].taskId, 'upstream');
  assert.equal(result.choices[0].immediateUnlocks, 2);
  assert.equal(result.choices[1].taskId, 'cosmetic');
  assert.deepEqual(result.blocked, ['downstream-a', 'downstream-b']);
  assert.equal(result.basis, 'caller-assertions-not-independent-proof');
});
test('focus task plan elevates real prerequisites of safety and deadline obligations', () => {
  const result = run([
    task('security-prerequisite', { value: 1, effortMinutes: 600 }),
    task('security-fix', { dependsOn: ['security-prerequisite'], obligation: 'safety' }),
    task('deadline-fix', { obligation: 'confirmed-imminent' }),
    task('quick-win', { value: 5, effortMinutes: 1 }),
  ]);
  assert.equal(result.choices[0].taskId, 'security-prerequisite');
  assert.equal(result.choices[0].lane, 'safety');
  assert.equal(result.choices[0].defersProtectedWork, false);
  assert.equal(result.choices[1].taskId, 'deadline-fix');
  assert.equal(result.choices[1].defersProtectedWork, true);
  assert.deepEqual(result.protectedUnresolved, ['security-fix']);
});
test('focus task plan does not replace an unknown mandatory estimate with optional scored work', () => {
  const result = run([task('urgent', { obligation: 'safety', effortMinutes: null }), task('easy')]);
  assert.equal(result.mode, 'estimate');
  assert.equal(result.choices[0].taskId, 'urgent');
  assert.equal(result.choices[0].action, 'estimate');
  assert.deepEqual(result.unscored, ['urgent']);
});
test('focus task plan keeps unknown eligibility and unresolved external obligations out of executable choices', () => {
  const result = run([task('owner-gate', { obligation: 'safety', eligibility: 'unknown' }),
    task('dependent', { dependsOn: ['owner-gate'] }), task('unknown-state', { state: 'unknown' }), task('parallel')]);
  assert.deepEqual(result.choices.map(c => c.taskId), ['parallel']);
  assert.equal(result.choices[0].defersProtectedWork, true);
  assert.deepEqual(result.protectedUnresolved, ['owner-gate']);
  assert.deepEqual(result.blocked, ['dependent', 'owner-gate', 'unknown-state']);
});
test('focus task plan distinguishes milestone decomposition and acceptance verification from execution', () => {
  const result = run([task('release-gate', { kind: 'milestone', obligation: 'safety', effortMinutes: null, value: null }),
    task('prior', { state: 'done' }),
    task('acceptance', { kind: 'milestone', effortMinutes: null, value: null, dependsOn: ['prior'] })]);
  assert.equal(result.mode, 'decompose');
  assert.deepEqual(result.needsDecomposition, ['release-gate']);
  assert.deepEqual(result.needsVerification, ['acceptance']);
  assert.equal(result.choices[1].action, 'verify');
});
test('focus task plan rejects duplicate ids, unknown prerequisites, cycles and contradictory completion', () => {
  const cases: [Task[], string][] = [
    [[task('same'), task('same')], 'duplicate-id'],
    [[task('child', { dependsOn: ['missing'] })], 'missing-dependency'],
    [[task('node-a', { dependsOn: ['node-b'] }), task('node-b', { dependsOn: ['node-a'] })], 'cycle'],
    [[task('self', { dependsOn: ['self'] })], 'cycle'],
    [[task('before'), task('after', { state: 'done', dependsOn: ['before'] })], 'contradictory-completion'],
  ];
  for (const [tasks, reason] of cases) assert.deepEqual(recommendWork({tasks, coverage: 'complete'}), { state: 'invalid', reason });
});
test('focus task plan preserves an explicitly chosen comparable ready focus but not across safety lanes', () => {
  const tasks = [task('first'), task('second')];
  assert.equal(run(tasks, { selectedFocus: 'second' }).choices[0].taskId, 'second');
  assert.equal(run([task('first', { obligation: 'safety' }), task('second')], { selectedFocus: 'second' }).choices[0].taskId, 'first');
  assert.equal(run([task('first'), task('second', { eligibility: 'blocked' })], { selectedFocus: 'second' }).choices[0].taskId, 'first');
});
test('focus task plan handles partial and empty coverage without claiming project completion', () => {
  assert.equal(run([], { coverage: 'partial' }).mode, 'blocked');
  assert.equal(run([], { coverage: 'complete' }).mode, 'no-open-work-in-snapshot');
  assert.equal(run([task('finished', { state: 'done' })]).choices.length, 0);
  const result = run([task('only')], { capacityMinutes: 2, coverage: 'partial' });
  assert.equal(result.choices.length, 1);
  assert.equal(result.choices[0].firstSliceMinutes, 2);
  assert.equal(result.coverage, 'partial');
});
test('focus task plan excludes unknown estimates without inventing scores or alternatives', () => {
  const result = run([task('estimate-me', { value: null })]);
  assert.equal(result.choices.length, 1);
  assert.equal(result.mode, 'estimate');
  assert.equal(result.choices[0].action, 'estimate');
  assert.ok(!Object.hasOwn(result.choices[0], 'score'));
});
test('focus task plan validates size, effort, value, milestones and capacity', () => {
  const cases: TaskSnapshot[] = [
    {tasks: Array.from({length: 201}, (_, i) => task('task-' + i)), coverage: 'complete'},
    {tasks: [task('bad', { effortMinutes: -1 })], coverage: 'complete'},
    {tasks: [task('bad', { value: 6 })], coverage: 'complete'},
    {tasks: [task('bad', { kind: 'milestone' })], coverage: 'complete'},
    {tasks: [task('bad', { dependsOn: ['bad', 'bad'] })], coverage: 'complete'},
    {tasks: [], coverage: 'complete', capacityMinutes: 0},
  ];
  for (const snapshot of cases) assert.deepEqual(recommendWork(snapshot), {state: 'invalid', reason: 'invalid-snapshot'});
});
