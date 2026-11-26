// Forgetting is complete across interrupted removals, half-written records, derived index rows, the index file's
// bytes and writers that share the store. Real holo, FileStore and SQLite index on temporary paths; fictional data.
// Each assertion reads the storage surface directly rather than trusting what forget() reports.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Kernel } from '../src/kernel.ts';
import { Memory, chunkOf, attributionOf, type Observed } from '../src/memory.ts';
import { labelOf } from '../src/address.ts';
import { FileStore, MemoryStore } from '../src/store.ts';
import { SearchIndex, loopRecord } from '../src/search.ts';

const NOW = Date.parse('2026-11-23T00:00:00Z');
const HOLO = fileURLToPath(new URL('../../app/.prism/build/q.holo', import.meta.url));
const WORD = 'zqxfictionalword';
const note = (o: Partial<Observed> = {}): Observed => ({
  channel: { kind: 'text', visibility: 'everyone', label: 'public', install: 'admin', intent: 'granted' },
  channelId: 'fictional-channel', authorId: 'fictional-member', origin: 'conversation',
  url: 'https://example.invalid/c1/m1', createdMs: NOW, text: `fictional words ${WORD}`, ...o,
});
const embedder = { model: 'fixture', async embed(t: string[]) { return t.map(() => [1, 0, 0]); } };

async function world(dir?: string) {
  dir ??= await mkdtemp(join(tmpdir(), 'q-forget-'));
  await mkdir(join(dir, 'store'), { recursive: true });
  const store = new FileStore(join(dir, 'store'));
  const index = new SearchIndex(join(dir, 'index.sqlite'));
  return { dir, store, index, memory: new Memory(await Kernel.open(HOLO), store, index, embedder, 30, () => NOW) };
}
/** Files in the store that still hold the word, and rows or raw bytes of the index file that do. */
async function holding(dir: string) {
  let files = 0, rows = 0, bytes = 0;
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p); else if ((await readFile(p)).includes(WORD)) files++;
    }
  };
  await walk(join(dir, 'store'));
  const file = join(dir, 'index.sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    for (const { name } of db.prepare("select name from sqlite_master where type = 'table'").all() as { name: string }[])
      for (const row of db.prepare(`select * from "${name}"`).all() as Record<string, unknown>[])
        if (Object.values(row).some((v) => (typeof v === 'string' ? v : v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : '').includes(WORD))) rows++;
  } finally { db.close(); }
  for (const f of [file, `${file}-journal`, `${file}-wal`]) if (existsSync(f)) bytes += (await readFile(f)).includes(WORD) ? 1 : 0;
  return { files, rows, bytes };
}

test('a forgotten message leaves no deleted text in the index file, including keyword segments and free pages', async () => {
  const w = await world(); const m = note();
  await w.memory.observe(m);
  assert.ok((await holding(w.dir)).rows > 0, 'precondition: indexed');
  await w.memory.forget({ author: m.authorId });
  assert.deepEqual(await holding(w.dir), { files: 0, rows: 0, bytes: 0 });
});

test('forgetting a member also removes the derived index rows that hold their questions', async () => {
  const w = await world();
  const gap = { type: 'gap', question: `asked ${WORD}`, url: 'https://example.invalid/q1', channel: 'c', author: 'fictional-member', asked: NOW, subjects: ['fictional-member'], created: NOW };
  loopRecord(w.index, await w.store.put('private', gap), gap);
  const other = { type: 'gap', question: 'unrelated question', url: 'https://example.invalid/q2', channel: 'c', author: 'someone-else', asked: NOW, subjects: ['someone-else'], created: NOW };
  loopRecord(w.index, await w.store.put('private', other), other);
  await w.memory.forget({ author: 'fictional-member' });
  assert.equal((await holding(w.dir)).rows, 0);
  assert.equal([...w.index.loopAll('gap')].length, 1, "another member's row stays");
});

test('a removal interrupted after the index step is finished by the next forget, leaving no index rows', async () => {
  const w = await world(); const m = note();
  await w.memory.observe(m);
  const remove = w.index.remove.bind(w.index);
  w.index.remove = () => { throw new Error('simulated crash'); };
  await assert.rejects(w.memory.forget({ author: m.authorId }));
  w.index.remove = remove;
  const restarted = await world(w.dir);
  await restarted.memory.forget({ author: m.authorId });
  const label = labelOf(chunkOf(m, m.text.trim()));
  assert.equal(restarted.index.has(label), false);
  assert.deepEqual(await holding(w.dir), { files: 0, rows: 0, bytes: 0 });
});

test('a record half-written by a crash is still reclaimed by forget-me, and only when it names that member', async () => {
  const w = await world();
  const mine = chunkOf(note(), note().text.trim());
  const theirs = chunkOf(note({ authorId: 'someone-else', url: 'https://example.invalid/c1/m2' }), `other ${WORD}`);
  await mkdir(join(w.dir, 'store', 'private', 'items'), { recursive: true });
  for (const item of [mine, theirs]) {
    const whole = JSON.stringify(item);
    await writeFile(join(w.dir, 'store', 'private', 'items', labelOf(item).replace(':', '-') + '.json'), whole.slice(0, whole.indexOf(WORD) + WORD.length));
  }
  // Torn anywhere after its text begins, a member record still names its author; torn earlier it names no one.
  const whole = JSON.stringify(mine);
  assert.equal(attributionOf(whole.slice(0, whole.indexOf(WORD))).author, 'fictional-member');
  assert.equal(attributionOf(whole.slice(0, whole.indexOf('"author"') + 5)).author, undefined);
  const restarted = await world(w.dir);
  await restarted.memory.forget({ author: 'fictional-member' });
  assert.equal(existsSync(join(w.dir, 'store', 'private', 'items', labelOf(mine).replace(':', '-') + '.json')), false);
  assert.equal(existsSync(join(w.dir, 'store', 'private', 'items', labelOf(theirs).replace(':', '-') + '.json')), true, "another member's torn record is not guessed at");
});

test('the store writes a record whole or not at all', async () => {
  const w = await world();
  const label = await w.store.put('private', { type: 'chunk', author: 'a', text: 'whole', created: NOW });
  const names = await readdir(join(w.dir, 'store', 'private', 'items'));
  assert.deepEqual(names, [label.replace(':', '-') + '.json'], 'no temporary file is left');
  assert.deepEqual(await w.store.inspect('private', label), { state: 'ok', item: { type: 'chunk', author: 'a', text: 'whole', created: NOW } });
  assert.deepEqual(await w.store.inspect('private', 'blake3:' + '0'.repeat(64)), { state: 'missing' });
});

test('a writer sharing the store cannot add a record of a member while their forget-me runs', async () => {
  const store = new MemoryStore();
  const memory = new Memory(await Kernel.open(HOLO), store, new SearchIndex(), embedder, 30, () => NOW);
  const labels = store.labels.bind(store);
  let late = '';
  store.labels = async (ns) => { const l = await labels(ns); late = await store.put('private', { type: 'turn', author: 'fictional-member', text: WORD, created: NOW }); return l; };
  await memory.forget({ author: 'fictional-member' });
  store.labels = labels;
  assert.equal(await store.has('private', late), false);
  // Admission is scoped to the forget: afterwards writes are admitted as before, and others' never were refused.
  const other = await store.put('private', { type: 'turn', author: 'someone-else', text: 'unrelated', created: NOW });
  assert.equal(await store.has('private', other), true);
  assert.equal(store.admits, undefined);
});
