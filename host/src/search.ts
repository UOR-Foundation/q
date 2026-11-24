// The search index: keyword postings and vectors, keyed by kappa label. It is
// derived from the store and holds nothing the store does not; delete it and
// `rebuild` gives it back.
import { DatabaseSync } from 'node:sqlite';
import type { Embedder } from './providers.ts';
import { isRevoked, type Namespace, type Store } from './store.ts';

export interface Hit { label: string; namespace: Namespace; similarity: number }

const cosine = (a: Float32Array, b: Float32Array) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
};

// FTS5 reads punctuation as syntax; a query is its words, any of them.
const words = (text: string) => (text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).map((w) => `"${w}"`).join(' OR ');

export class SearchIndex {
  #db: DatabaseSync;
  constructor(path = ':memory:') {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      create table if not exists chunk (label text primary key, namespace text not null, vector blob not null);
      create virtual table if not exists words using fts5(label unindexed, body);
    `);
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
  search(text: string, vector: number[], limit: number): Hit[] {
    const query = new Float32Array(vector);
    const rows = this.#db.prepare('select label, namespace, vector from chunk').all() as { label: string; namespace: Namespace; vector: Uint8Array }[];
    const scored = rows.map((row) => ({
      label: row.label,
      namespace: row.namespace,
      similarity: cosine(query, new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4)),
    }));
    const byVector = [...scored].sort((a, b) => b.similarity - a.similarity).map((hit) => hit.label);
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
    this.#db.exec('delete from chunk; delete from words;');
    for (const namespace of ['public', 'private'] as const) {
      for (const label of await store.labels(namespace)) {
        const item = await store.get(namespace, label);
        if (item?.type !== 'chunk' || typeof item.text !== 'string' || (await isRevoked(store, namespace, label))) continue;
        const [vector] = await embedder.embed([item.text]);
        this.add(label, namespace, item.text, vector);
      }
    }
  }
}
