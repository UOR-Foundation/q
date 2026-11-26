// What the agent keeps of Discord, and how it lets go: indexing a message,
// forgetting an author or a channel, and the retention sweep. Each is a question
// to the kernel first.
import { labelOf } from './address.ts';
import type { ChannelFacts, Kernel, Origin } from './kernel.ts';
import type { Embedder } from './providers.ts';
import type { SearchIndex } from './search.ts';
import { isRevoked, type Namespace, type Store } from './store.ts';

export interface Observed {
  channel: ChannelFacts;
  channelId: string;
  /** The thread the message is in, when it is in one. */
  threadId?: string;
  authorId: string;
  origin: Origin;
  /** The message this one replies to, as its link. */
  replyTo?: string;
  /** The author's role, when the platform knows it: an admin's correction needs no second member (decision 27). */
  role?: 'member' | 'admin';
  url: string;
  createdMs: number;
  text: string;
}

const DAY = 86_400_000;

/** The item a message becomes, built from the message alone, so its label can be recomputed from the message. */
export const chunkOf = (message: Observed, text: string) => ({
  type: 'chunk', source: 'discord', level: 'open', url: message.url, channel: message.channelId,
  thread: message.threadId ?? null, author: message.authorId, replyTo: message.replyTo ?? null, created: message.createdMs, text,
});

/**
 * A member's reply to Q, kept while it may become a correction (decision 26). Not a chunk, so it is never searched
 * until the kernel decides to learn it; built from the message alone, so its label too is recomputed on withdrawal.
 */
export const replyOf = (message: Observed, text: string) => ({ ...chunkOf(message, text), type: 'reply' });

/** Why an item was removed, as its revocation records it: the self-model counts what Q forgot, and why. */
export type Reason = 'forget-me' | 'forget-channel' | 'withdrawn' | 'retention' | 'unlearned';

/** Whether a record names this member: as its author, or among the members it was derived from. */
const names = (item: { [member: string]: unknown }, member: string) =>
  item.author === member || (Array.isArray(item.subjects) && item.subjects.includes(member));

/** Records that make forgetting hold: never refused, never forgotten. */
const EXEMPT = new Set(['opt-out', 'revocation']);

/**
 * The attribution a torn record still carries: JSON.stringify keeps the order a record was built in, and member records
 * name author, channel, thread and creation time before their text. Absent fields stay unknown.
 */
export function attributionOf(bytes: string): { author?: string; channel?: string; thread?: string; created?: number } {
  const field = (name: string) => {
    const match = new RegExp(`"${name}":("(?:[^"\\\\]|\\\\.)*")`).exec(bytes);
    if (!match) return undefined;
    try { return JSON.parse(match[1]) as string; } catch { return undefined; }
  };
  const created = /"created":(\d+)/.exec(bytes);
  return { author: field('author'), channel: field('channel'), thread: field('thread'), created: created ? Number(created[1]) : undefined };
}

export class Memory {
  kernel: Kernel;
  store: Store;
  index: SearchIndex;
  embedder: Embedder;
  retentionDays: number;
  now: () => number;
  /** Called after an item is removed, so what was learned from it is undone too (improve.ts). */
  removed?: (label: string, item: { type: string; [member: string]: unknown }) => Promise<void>;

  constructor(kernel: Kernel, store: Store, index: SearchIndex, embedder: Embedder, retentionDays: number, now: () => number = Date.now) {
    this.kernel = kernel; this.store = store; this.index = index; this.embedder = embedder; this.retentionDays = retentionDays; this.now = now;
  }

  // Serialize the store/index mutation phases in this Memory instance. Embedding
  // runs outside the queue; removal callbacks may call unlearn directly.
  #tail: Promise<unknown> = Promise.resolve();
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(work);
    this.#tail = next.catch(() => {});
    return next;
  }

  #namespace(): Promise<Namespace> {
    return this.kernel.namespace('discord');
  }

  /** An opt-out is an item: the author has opted out exactly when it is in the store. */
  async optedOut(authorId: string): Promise<boolean> {
    return this.store.has(await this.#namespace(), labelOf({ type: 'opt-out', author: authorId }));
  }

  /** Index one Discord message if the kernel admits it. Returns what was done. */
  async observe(message: Observed): Promise<'index' | 'skip'> {
    const text = message.text.trim();
    if (!text) return 'skip';
    const item = chunkOf(message, text);
    const label = labelOf(item);
    const pending = await this.#serial(async () => {
      const decision = await this.kernel.index(message.channel, message.origin, await this.optedOut(message.authorId));
      if (decision === 'skip') return null;
      const ageDays = Math.floor((this.now() - message.createdMs) / DAY);
      if ((await this.kernel.retain('discord', false, ageDays, this.retentionDays)) === 'delete') return null;
      const namespace = await this.#namespace();
      if (await isRevoked(this.store, namespace, label)) return null;
      await this.store.put(namespace, item);
      return { namespace, indexed: this.index.has(label) };
    });
    if (!pending) return 'skip';
    if (pending.indexed) return 'index';
    const [vector] = await this.embedder.embed([text]);
    return this.#serial(async () => {
      // An embedding may finish after removal. Its result is not admission.
      if (!(await this.store.has(pending.namespace, label)) ||
          await isRevoked(this.store, pending.namespace, label) ||
          await this.optedOut(message.authorId)) return 'skip';
      if (!this.index.has(label)) this.index.add(label, pending.namespace, text, vector);
      return 'index';
    });
  }

  async #remove(namespace: Namespace, label: string, reason: Reason, item?: { type: string; [member: string]: unknown }) {
    const was = item ?? (await this.store.get(namespace, label));
    // Projections first, then the record they derive from: an interruption leaves the record, which the next walk
    // finds again, rather than index rows no walk over the store can reach.
    this.index.remove(label);
    this.index.removeDerived([label]);
    await this.store.delete(namespace, label);
    const revocation = await this.store.put(namespace, { type: 'revocation', target: label, reason, at: this.now() });
    await this.store.link(namespace, { source: revocation, target: label, relation: 'revocation' });
    if (was && this.removed) await this.removed(label, was);
  }

  async #each(reason: Reason, visit: (label: string, item: { type: string; [member: string]: unknown }, ageDays: number) => Promise<boolean>): Promise<number> {
    const namespace = await this.#namespace();
    let removed = 0;
    for (const label of await this.store.labels(namespace)) {
      const item = await this.store.get(namespace, label);
      // Opt-outs and revocations are what make forgetting hold; they are not themselves forgotten.
      if (!item || item.type === 'opt-out' || item.type === 'revocation') continue;
      const ageDays = Math.floor((this.now() - Number(item.created ?? this.now())) / DAY);
      if (await visit(label, item, ageDays)) {
        await this.#remove(namespace, label, reason, item);
        removed++;
      }
    }
    // A record a crash tore no longer parses, so the walk above cannot see it, but it may still hold content. Q writes
    // a member record's author, channel and creation time before its text, so a torn record that holds any text still
    // names them; what it does not name is left, never guessed.
    if (this.store.inspect) {
      for (const label of await this.store.labels(namespace)) {
        const found = await this.store.inspect(namespace, label);
        if (found.state !== 'torn') continue;
        const torn = { type: 'torn', ...attributionOf(found.bytes) };
        const ageDays = Math.floor((this.now() - Number(torn.created ?? this.now())) / DAY);
        if (!(await visit(label, torn, ageDays))) continue;
        this.index.remove(label);
        this.index.removeDerived([label]);
        await this.store.delete(namespace, label);
        const revocation = await this.store.put(namespace, { type: 'revocation', target: label, reason, at: this.now() });
        await this.store.link(namespace, { source: revocation, target: label, relation: 'revocation' });
        removed++;
      }
    }
    // Index rows of a revoked record whose bytes are already gone: what an interrupted removal left behind.
    const stored = new Set(await this.store.labels(namespace));
    for (const label of this.index.labels(namespace)) {
      if (!stored.has(label) && (await isRevoked(this.store, namespace, label))) { this.index.remove(label); this.index.removeDerived([label]); }
    }
    return removed;
  }

  /**
   * Forget everything from one author, or from one channel. For an author that is every record that names them,
   * as its author or as a member it was derived from: their messages and turns, and the gaps, tests, signals and
   * corrections made from them. An author who asks is also opted out from then on.
   */
  async forget(match: { author: string } | { channel: string }): Promise<number> {
    return this.#serial(async () => {
      const named = (item: { [member: string]: unknown }) =>
        'author' in match ? names(item, match.author) : item.channel === match.channel || item.thread === match.channel;
      // The opt-out first, so no observation of this author is admitted while the walk runs.
      if ('author' in match) await this.store.put(await this.#namespace(), { type: 'opt-out', author: match.author });
      // While this forget runs, this store refuses any record it names, from any writer sharing the instance; a
      // record written just before is caught by the second walk.
      const previous = this.store.admits;
      this.store.admits = (namespace, item) => (EXEMPT.has(String(item.type)) || !named(item)) && (previous?.(namespace, item) ?? true);
      try {
        const walk = () => this.#each('author' in match ? 'forget-me' : 'forget-channel', async (_label, item, ageDays) =>
          named(item) && (await this.kernel.retain('discord', true, ageDays, this.retentionDays)) === 'delete');
        const removed = (await walk()) + (await walk());
        if ('author' in match) this.index.removeDerived([], match.author);
        return removed;
      } finally {
        this.store.admits = previous;
      }
    });
  }

  /**
   * A message its author deleted or edited: what was indexed of it goes, as asked. When the old text is known, the
   * chunk's BLAKE3 label is recomputed from it and names the item directly; otherwise every chunk is checked by link.
   */
  async withdraw(url: string, before?: Observed): Promise<number> {
    return this.#serial(() => this.#withdraw(url, before));
  }

  async #withdraw(url: string, before?: Observed): Promise<number> {
    const requested = async (ageDays: number) => (await this.kernel.retain('discord', true, ageDays, this.retentionDays)) === 'delete';
    const text = before?.text.trim();
    if (before && text) {
      const namespace = await this.#namespace();
      if (!(await requested(Math.floor((this.now() - before.createdMs) / DAY)))) return 0;
      // The message as a chunk, and as a reply to Q kept while it may become a correction.
      let removed = 0;
      for (const label of [labelOf(chunkOf(before, text)), labelOf(replyOf(before, text))]) {
        if (!(await this.store.has(namespace, label))) continue;
        await this.#remove(namespace, label, 'withdrawn');
        removed++;
      }
      return removed;
    }
    return this.#each('withdrawn', async (_label, item, ageDays) => (item.type === 'chunk' || item.type === 'reply') && item.url === url && (await requested(ageDays)));
  }

  /** Remove an item Q held only because of what it learned, now that the learning is undone (improve.ts). */
  async unlearn(label: string): Promise<void> {
    const namespace = await this.#namespace();
    if (await this.store.has(namespace, label)) await this.#remove(namespace, label, 'unlearned');
  }

  /** Delete what is past its age limit: every record dated by `created`, which is every record made from a member. */
  sweep(): Promise<number> {
    return this.#serial(() => this.#each('retention', async (_label, _item, ageDays) => (await this.kernel.retain('discord', false, ageDays, this.retentionDays)) === 'delete'));
  }
}
