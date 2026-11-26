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
      create table if not exists question (key text primary key, manifest text not null, answer text not null, context text not null);
    `);
    // The keys an answer builds on came later than the table: a file made before them gains the column.
    if (!(this.#db.prepare('pragma table_info(question)').all() as { name: string }[]).some((column) => column.name === 'after')) this.#db.exec("alter table question add column after text not null default '[]'");
    this.#dataVersion = this.#readDataVersion();
  }

  close(): void { this.#db.close(); }

  #dataVersion: number;
  #readDataVersion(): number {
    return (this.#db.prepare('pragma data_version').get() as { data_version: number }).data_version;
  }
  #refreshExternalChanges(): void {
    const version = this.#readDataVersion();
    if (version !== this.#dataVersion) {
      // External commits can delete, replace or revector existing rowids.
      this.#vectors.clear();
      this.#seen = 0;
      this.#dataVersion = version;
      this.#revision++;
    }
  }

  #transaction<T>(work: () => T): T {
    this.#db.exec('begin immediate');
    try {
      const value = work();
      this.#db.exec('commit');
      return value;
    } catch (error) {
      this.#db.exec('rollback');
      throw error;
    }
  }

  #revision = 0;
  /** Local chunk changes and observed external database commits invalidate derived caches. */
  get revision(): number {
    this.#refreshExternalChanges();
    return this.#revision;
  }

  /**
   * The website's memo: a question key (the BLAKE3 label of a question and the manifest it was asked under)
   * to the answer computed for it. A key a browser can compute alone, so a repeat needs no retrieval.
   * A cache, rebuilt by use: nothing here is not also in the answer records.
   */
  questionGet(key: string): { manifest: string; answer: string; context: string; after: string[] } | undefined {
    const row = this.#db.prepare('select manifest, answer, context, after from question where key = ?').get(key) as { manifest: string; answer: string; context: string; after: string } | undefined;
    return row && { ...row, after: JSON.parse(row.after) as string[] };
  }
  /** `after` is the keys of the earlier answers this one builds on: part of its key, and of its public record. */
  questionSet(key: string, manifest: string, answer: string, context: string, after: readonly string[] = []) {
    this.#db.prepare('insert or replace into question (key, manifest, answer, context, after) values (?, ?, ?, ?, ?)').run(key, manifest, answer, context, JSON.stringify(after));
  }
  questionDelete(key: string) {
    this.#db.prepare('delete from question where key = ?').run(key);
  }
  /** Keys asked under any manifest but the current ones, one for each register, can never be asked again: the manifest is part of the key. */
  questionKeep(manifests: readonly string[]) {
    this.#db.prepare(`delete from question where manifest not in (${manifests.map(() => '?').join(', ')})`).run(...manifests);
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
    const result = this.#db.prepare('update chunk set vector = ? where label = ?').run(new Uint8Array(new Float32Array(vector).buffer), label);
    const known = this.#vectors.get(label);
    if (known) known.unit = unit(new Float32Array(vector));
    if (Number(result.changes) > 0) this.#revision++;
  }

  has(label: string): boolean {
    return this.#db.prepare('select 1 from chunk where label = ?').get(label) !== undefined;
  }
  add(label: string, namespace: Namespace, text: string, vector: number[]) {
    const added = this.#transaction(() => {
      if (this.has(label)) return false;
      this.#db.prepare('insert into chunk values (?, ?, ?)').run(label, namespace, new Uint8Array(new Float32Array(vector).buffer));
      this.#db.prepare('insert into words values (?, ?)').run(label, text);
      return true;
    });
    if (!added) return;
    // SQLite may reuse a deleted rowid; do not depend on rowid growth for local additions.
    this.#vectors.set(label, { namespace, unit: unit(new Float32Array(vector)) });
    this.#revision++;
  }
  remove(label: string) {
    this.#transaction(() => {
      this.#db.prepare('delete from chunk where label = ?').run(label);
      this.#db.prepare('delete from words where label = ?').run(label);
    });
    this.#vectors.delete(label);
    this.#revision++;
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
    this.#refreshExternalChanges();
    const rows = this.#db.prepare('select rowid, label, namespace, vector from chunk where rowid > ? order by rowid').all(this.#seen) as { rowid: number; label: string; namespace: Namespace; vector: Uint8Array }[];
    for (const row of rows) {
      this.#vectors.set(row.label, { namespace: row.namespace, unit: unit(new Float32Array(row.vector.buffer.slice(row.vector.byteOffset, row.vector.byteOffset + row.vector.byteLength))) });
      this.#seen = row.rowid;
    }
  }

  /** Only the namespaces given are searched: the ones the kernel serves on the surface that asked. */
  search(text: string, vector: number[], limit: number, namespaces: readonly Namespace[] = ['public', 'private']): Hit[] {
    this.#catchUp();
    const query = unit(new Float32Array(vector));
    const scored: Hit[] = [];
    for (const [label, { namespace, unit: v }] of this.#vectors) {
      if (!namespaces.includes(namespace)) continue;
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
    return [...fused.entries()].filter(([label]) => hits.has(label)).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([label]) => hits.get(label)!);
  }

  /** Fill the index from the store: every chunk the store holds and has not revoked, and nothing else. */
  async rebuild(store: Store, embedder: Embedder) {
    this.#transaction(() => this.#db.exec('delete from chunk; delete from words; delete from memo; delete from loop; delete from question;'));
    this.#vectors.clear();
    this.#seen = 0;
    this.#revision++;
    // A member's answer Q learned, a filled gap's or a correction's, is searched by the question it answers.
    const learned: { question: string; chunk: string }[] = [];
    for (const namespace of ['public', 'private'] as const) {
      for (const label of await store.labels(namespace)) {
        const item = await store.get(namespace, label);
        // Only an answer computed for its key is the key's answer; one that reused it points back to it.
        if (item?.type === 'answer' && typeof item.memo === 'string' && item.reused === null && typeof item.context === 'string') this.memoSet(item.memo, label, item.context);
        if (item) loopRecord(this, label, item);
        if ((item?.type === 'gap-fill' || item?.type === 'correction') && typeof item.question === 'string') learned.push({ question: item.question, chunk: String(item.chunk) });
        else if (item?.type === 'gap-fill') {
          // A fill from before the fill named its question: read it from the gap.
          const gap = await store.get('private', String(item.gap));
          if (gap) learned.push({ question: String(gap.question), chunk: String(item.chunk) });
        }
        if (item?.type !== 'chunk' || typeof item.text !== 'string' || (await isRevoked(store, namespace, label))) continue;
        const [vector] = await embedder.embed([item.text]);
        this.add(label, namespace, item.text, vector);
      }
    }
    for (const { question, chunk } of learned) {
      const answer = await store.get('private', chunk);
      if (!answer || !this.has(chunk)) continue;
      const [vector] = await embedder.embed([`${question}\n${answer.text}`]);
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
  if (item.type === 'delivery' && typeof item.url === 'string') {
    index.loopSet('delivery', item.url, { label, answer: item.answer, question: item.question, author: item.author, decision: item.decision ?? null, grounded: item.grounded, cited: item.cited ?? null, citedUrl: item.citedUrl ?? null, area: item.area ?? null });
  }
  if (item.type === 'test-case') index.loopSet('test', label, { question: item.question, source: item.source, cites: item.cites ?? null, created: item.created ?? item.added });
  if (item.type === 'signal') index.loopSet('signal', label, { kind: item.kind, about: item.about, author: item.author, words: item.words, role: item.role, on: item.on });
  if (item.type === 'reply' && typeof item.url === 'string') index.loopSet('reply', item.url, { label, on: item.replyTo, author: item.author });
  if (item.type === 'correction' && typeof item.reply === 'string') index.loopSet('correction', item.reply, { label, outcome: item.outcome, chunk: item.chunk });
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
  if (item.type === 'tracked' && typeof item.url === 'string') {
    const was = index.loopGet<{ closed: string | null }>('tracked', item.url);
    index.loopSet('tracked', item.url, { label, kind: item.kind, url: item.url, channel: item.channel, author: item.author, summary: item.summary, due: item.due, at: item.at, closed: was?.closed ?? null });
  }
  if (item.type === 'tracked-close' && typeof item.url === 'string') {
    const tracked = index.loopGet<Record<string, unknown>>('tracked', item.url);
    if (tracked) index.loopSet('tracked', item.url, { ...tracked, closed: label });
  }
  if (item.type === 'review') {
    const latest = index.loopGet<{ at: number }>('review', 'latest');
    if (!latest || Number(item.at) > latest.at) index.loopSet('review', 'latest', { label, at: item.at });
  }
}
