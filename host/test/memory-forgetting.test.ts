// Scoped index-deletion and retry tests using fictional records and the real kernel.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Kernel } from '../src/kernel.ts';
import { Memory, chunkOf, type Observed } from '../src/memory.ts';
import { labelOf } from '../src/address.ts';
import { FileStore, isRevoked } from '../src/store.ts';
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

test('a newly indexed fictional message is absent from inspected SQLite rows and files after removal', async () => {
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


test('a failed revocation link leaves the record available for retry', async () => {
  const w = await world();
  try {
    const m = note();
    await w.memory.observe(m);
    const label = labelOf(chunkOf(m, m.text.trim()));
    const link = w.store.link.bind(w.store);
    w.store.link = async () => { throw Error('synthetic link failure'); };
    await assert.rejects(w.memory.forget({ author: m.authorId }), /synthetic link failure/);
    assert.equal(await w.store.has('private', label), true);
    assert.equal(w.index.has(label), false);
    w.store.link = link;
    await w.memory.forget({ author: m.authorId });
    assert.equal(await w.store.has('private', label), false);
    assert.equal(await isRevoked(w.store, 'private', label), true);
    assert.deepEqual(await holding(w.dir), { files: 0, rows: 0, bytes: 0 });
  } finally {
    w.index.close();
    await rm(w.dir, {recursive:true,force:true});
  }
});
