// What the agent keeps of Discord, and how it lets go: indexing a message,
// forgetting an author or a channel, and the retention sweep. Each is a question
// to the kernel first.
import { labelOf } from './address.ts';
import type { ChannelFacts, Kernel, Origin } from './kernel.ts';
import type { Embedder } from './providers.ts';
import type { SearchIndex } from './search.ts';
import type { Namespace, Store } from './store.ts';

export interface Observed {
  channel: ChannelFacts;
  channelId: string;
  /** The thread the message is in, when it is in one. */
  threadId?: string;
  authorId: string;
  origin: Origin;
  /** The message this one replies to, as its link. */
  replyTo?: string;
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

export class Memory {
  kernel: Kernel;
  store: Store;
  index: SearchIndex;
  embedder: Embedder;
  retentionDays: number;
  now: () => number;

  constructor(kernel: Kernel, store: Store, index: SearchIndex, embedder: Embedder, retentionDays: number, now: () => number = Date.now) {
    this.kernel = kernel; this.store = store; this.index = index; this.embedder = embedder; this.retentionDays = retentionDays; this.now = now;
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
    const decision = await this.kernel.index(message.channel, message.origin, await this.optedOut(message.authorId));
    const text = message.text.trim();
    // A message with no text has nothing to index, whatever the decision.
    if (decision === 'skip' || !text) return 'skip';
    const namespace = await this.#namespace();
    const label = await this.store.put(namespace, chunkOf(message, text));
    if (!this.index.has(label)) {
      const [vector] = await this.embedder.embed([text]);
      this.index.add(label, namespace, text, vector);
    }
    return 'index';
  }

  async #remove(namespace: Namespace, label: string) {
    await this.store.delete(namespace, label);
    this.index.remove(label);
    const revocation = await this.store.put(namespace, { type: 'revocation', target: label, at: this.now() });
    await this.store.link(namespace, { source: revocation, target: label, relation: 'revocation' });
  }

  async #each(visit: (label: string, item: { type: string; [member: string]: unknown }, ageDays: number) => Promise<boolean>): Promise<number> {
    const namespace = await this.#namespace();
    let removed = 0;
    for (const label of await this.store.labels(namespace)) {
      const item = await this.store.get(namespace, label);
      // Opt-outs and revocations are what make forgetting hold; they are not themselves forgotten.
      if (!item || item.type === 'opt-out' || item.type === 'revocation') continue;
      const ageDays = Math.floor((this.now() - Number(item.created ?? this.now())) / DAY);
      if (await visit(label, item, ageDays)) {
        await this.#remove(namespace, label);
        removed++;
      }
    }
    return removed;
  }

  /** Forget everything from one author, or from one channel. An author who asks is also opted out from then on. */
  async forget(match: { author: string } | { channel: string }): Promise<number> {
    const removed = await this.#each(async (_label, item, ageDays) => {
      const named = 'author' in match ? item.author === match.author : item.channel === match.channel || item.thread === match.channel;
      return named && (await this.kernel.retain('discord', true, ageDays, this.retentionDays)) === 'delete';
    });
    if ('author' in match) await this.store.put(await this.#namespace(), { type: 'opt-out', author: match.author });
    return removed;
  }

  /**
   * A message its author deleted or edited: what was indexed of it goes, as asked. When the old text is known, the
   * chunk's BLAKE3 label is recomputed from it and names the item directly; otherwise every chunk is checked by link.
   */
  async withdraw(url: string, before?: Observed): Promise<number> {
    const requested = async (ageDays: number) => (await this.kernel.retain('discord', true, ageDays, this.retentionDays)) === 'delete';
    const text = before?.text.trim();
    if (before && text) {
      const namespace = await this.#namespace();
      const label = labelOf(chunkOf(before, text));
      if (!(await this.store.has(namespace, label))) return 0;
      if (!(await requested(Math.floor((this.now() - before.createdMs) / DAY)))) return 0;
      await this.#remove(namespace, label);
      return 1;
    }
    return this.#each(async (_label, item, ageDays) => item.type === 'chunk' && item.url === url && (await requested(ageDays)));
  }

  /** Delete what is past its age limit. */
  sweep(): Promise<number> {
    return this.#each(async (_label, _item, ageDays) => (await this.kernel.retain('discord', false, ageDays, this.retentionDays)) === 'delete');
  }
}
