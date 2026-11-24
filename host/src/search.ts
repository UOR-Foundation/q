// The search index: keyword postings and vectors, keyed by kappa label. It is
// derived from the store and holds nothing the store does not; delete it and
// `rebuild` gives it back.
import { DatabaseSync } from 'node:sqlite';
import type { Embedder } from './providers.ts';
import { isRevoked, type Namespace, type Store } from './store.ts';

export interface Hit { label: string; namespace: Namespace; similarity: number }

/** A vector scaled to unit length, so cosine similarity is a dot product. */
const unit = (v: Float32Array) => {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  const scale = n > 0 ? 1 / Math.sqrt(n) : 0;
  for (let i = 0; i < v.length; i++) v[i] *= scale;
  return v;
};


// FTS5 reads punctuation as syntax; a query is its words, any of them.
const words = (text: string) => (text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).map((w) => `"${w}"`).join(' OR ');

export class SearchIndex {
  #db: DatabaseSync;
  constructor(path = ':memory:') {
    this.#db = new DatabaseSync(path);
    // The live bot and a backfill share the file: a writer waits its turn instead of failing with "database is locked".
    this.#db.exec('pragma busy_timeout = 30000');
    this.#db.exec(`
      create table if not exists chunk (label text primary key, namespace text not null, vector blob not null);
      create virtual table if not exists words using fts5(label unindexed, body);
      create table if not exists memo (key text primary key, answer text not null, context text not null);
      create table if not exists loop (kind text not null, key text not null, value text not null, primary key (kind, key));
    `);
  }

  /**
   * The memo: an answer key (the BLAKE3 label of everything an answer depends on) to the answer record
   * computed for it and its context. Derived from the answer records, like the rest of the index.
   */
  memoGet(key: string): { answer: string; context: string } | undefined {
    return this.#db.prepare('select answer, context from memo where key = ?').get(key) as { answer: string; context: string } | undefined;
  }
  memoSet(key: string, answer: string, context: string) {
    this.#db.prepare('insert or replace into memo values (?, ?, ?)').run(key, answer, context);
  }
  memoDelete(key: string) {
    this.#db.prepare('delete from memo where key = ?').run(key);
  }

  /**
   * The improvement loop's lookups (improve.ts): its gaps by the question's link, its deliveries by the reply's
   * link, its tests, its latest review. Derived from the store's records, like the memo.
   */
  loopGet<T>(kind: string, key: string): T | undefined {
    const row = this.#db.prepare('select value from loop where kind = ? and key = ?').get(kind, key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  loopSet(kind: string, key: string, value: unknown) {
    this.#db.prepare('insert or replace into loop values (?, ?, ?)').run(kind, key, JSON.stringify(value));
  }
  loopAll<T>(kind: string): { key: string; value: T }[] {
    return (this.#db.prepare('select key, value from loop where kind = ? order by key').all(kind) as { key: string; value: string }[]).map((r) => ({ key: r.key, value: JSON.parse(r.value) as T }));
  }
  loopDelete(kind: string, key: string) {
    this.#db.prepare('delete from loop where kind = ? and key = ?').run(kind, key);
  }
  /** Search a chunk by another vector: a member's answer is found by the question it answers. */
  revector(label: string, vector: number[]) {
    this.#db.prepare('update chunk set vector = ? where label = ?').run(new Uint8Array(new Float32Array(vector).buffer), label);
    const known = this.#vectors.get(label);
    if (known) known.unit = unit(new Float32Array(vector));
  }

  has(label: string): boolean {
    return this.#db.prepare('select 1 from chunk where label = ?').get(label) !== undefined;
  }
  add(label: string, namespace: Namespace, text: string, vector: number[]) {
    if (this.has(label)) return;
    this.#db.prepare('insert into chunk values (?, ?, ?)').run(label, namespace, new Uint8Array(new Float32Array(vector).buffer));
    this.#db.prepare('insert into words values (?, ?)').run(label, text);
  }
  remove(label: string) {
    this.#vectors.delete(label);
    this.#db.prepare('delete from chunk where label = ?').run(label);
    this.#db.prepare('delete from words where label = ?').run(label);
  }
  labels(namespace: Namespace): string[] {
    return (this.#db.prepare('select label from chunk where namespace = ?').all(namespace) as { label: string }[]).map((row) => row.label);
  }
  count(): number {
    return (this.#db.prepare('select count(*) n from chunk').get() as { n: number }).n;
  }

  /** Keyword and vector ranks fused by reciprocal rank; each hit carries its cosine similarity, a measurement. */
  /**
   * The vectors, unit length, in memory: a search is one dot product per chunk instead of reading every vector from
   * disk. New rows are read by rowid at each search, so chunks another process adds (a backfill) are found too.
   */
  #vectors = new Map<string, { namespace: Namespace; unit: Float32Array }>();
  #seen = 0;
  #catchUp() {
    const rows = this.#db.prepare('select rowid, label, namespace, vector from chunk where rowid > ? order by rowid').all(this.#seen) as { rowid: number; label: string; namespace: Namespace; vector: Uint8Array }[];
    for (const row of rows) {
      this.#vectors.set(row.label, { namespace: row.namespace, unit: unit(new Float32Array(row.vector.buffer.slice(row.vector.byteOffset, row.vector.byteOffset + row.vector.byteLength))) });
      this.#seen = row.rowid;
    }
  }

  search(text: string, vector: number[], limit: number): Hit[] {
    this.#catchUp();
    const query = unit(new Float32Array(vector));
    const scored: Hit[] = [];
    for (const [label, { namespace, unit: v }] of this.#vectors) {
      let dot = 0;
      for (let i = 0; i < v.length; i++) dot += query[i] * v[i];
      scored.push({ label, namespace, similarity: dot });
    }
    // Past the first few hundred, a rank adds nothing to the fused score that could change the top results.
    const byVector = scored.sort((a, b) => b.similarity - a.similarity).slice(0, 500).map((hit) => hit.label);
    const match = words(text);
    const byWords = match
      ? (this.#db.prepare('select label from words where words match ? order by bm25(words) limit 50').all(match) as { label: string }[]).map((r) => r.label)
      : [];
    const fused = new Map<string, number>();
    for (const ranking of [byVector, byWords]) ranking.forEach((label, rank) => fused.set(label, (fused.get(label) ?? 0) + 1 / (60 + rank)));
    const hits = new Map(scored.map((hit) => [hit.label, hit]));
    return [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([label]) => hits.get(label)!);
  }

  /** Fill the index from the store: every chunk the store holds and has not revoked, and nothing else. */
  async rebuild(store: Store, embedder: Embedder) {
    this.#db.exec('delete from chunk; delete from words; delete from memo; delete from loop;');
    this.#vectors.clear();
    this.#seen = 0;
    const fills: { gap: string; chunk: string }[] = [];
    for (const namespace of ['public', 'private'] as const) {
      for (const label of await store.labels(namespace)) {
        const item = await store.get(namespace, label);
        // Only an answer computed for its key is the key's answer; one that reused it points back to it.
        if (item?.type === 'answer' && typeof item.memo === 'string' && item.reused === null && typeof item.context === 'string') this.memoSet(item.memo, label, item.context);
        if (item) loopRecord(this, label, item);
        if (item?.type === 'gap-fill') fills.push({ gap: String(item.gap), chunk: String(item.chunk) });
        if (item?.type !== 'chunk' || typeof item.text !== 'string' || (await isRevoked(store, namespace, label))) continue;
        const [vector] = await embedder.embed([item.text]);
        this.add(label, namespace, item.text, vector);
      }
    }
    // A filled gap's answer is searched by the question it answers.
    for (const { gap, chunk } of fills) {
      const [question, answer] = [await store.get('private', gap), await store.get('private', chunk)];
      if (!question || !answer || !this.has(chunk)) continue;
      const [vector] = await embedder.embed([`${question.question}
${answer.text}`]);
      this.revector(chunk, vector);
    }
  }
}

/** Index one record of the improvement loop under the key its lookup uses. */
export function loopRecord(index: SearchIndex, label: string, item: { type: string; [member: string]: unknown }) {
  if (item.type === 'gap' && typeof item.url === 'string') {
    const was = index.loopGet<{ filled: string | null }>('gap', item.url);
    index.loopSet('gap', item.url, { label, question: item.question, channel: item.channel, asked: item.asked, author: item.author, filled: was?.filled ?? null });
  }
  if (item.type === 'gap-fill' && typeof item.url === 'string') {
    const gap = index.loopGet<Record<string, unknown>>('gap', item.url);
    index.loopSet('gap', item.url, { ...(gap ?? {}), filled: label });
  }
  if (item.type === 'delivery' && typeof item.url === 'string') index.loopSet('delivery', item.url, { answer: item.answer, question: item.question, grounded: item.grounded });
  if (item.type === 'test-case') index.loopSet('test', label, { question: item.question, source: item.source, added: item.added });
  if (item.type === 'genome') {
    const latest = index.loopGet<{ at: number }>('genome', 'latest');
    if (!latest || Number(item.at) >= latest.at) index.loopSet('genome', 'latest', { label, at: item.at });
  }
  if (item.type === 'request') {
    const was = index.loopGet<{ filed: string | null }>('request', label);
    index.loopSet('request', label, { kind: item.kind, text: item.text, filed: was?.filed ?? null });
  }
  if (item.type === 'feedback') index.loopSet('feedback', label, { request: item.request, author: item.author, kind: item.kind });
  if (item.type === 'request-filed' && typeof item.request === 'string') {
    const request = index.loopGet<Record<string, unknown>>('request', item.request);
    index.loopSet('request', item.request, { ...(request ?? {}), filed: item.issue });
  }
  if (item.type === 'review') {
    const latest = index.loopGet<{ at: number }>('review', 'latest');
    if (!latest || Number(item.at) > latest.at) index.loopSet('review', 'latest', { label, at: item.at });
  }
}
