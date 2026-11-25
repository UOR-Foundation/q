// The tracker: every question, promise and request made in the server's public channels, kept until it is answered or
// kept, so none is missed. Admins see what is open with /open and in a daily digest; members' words never go further.
//
// Why: a community loses trust in small ways: a newcomer's question nobody answered, a "I'll send it Friday" nobody
// remembered. Q already reads every public message; it can hold each of these open until a person closes it.
//
// How:
//   Catch   A message Q indexed (decision 2: a public channel, a human who has not opted out) that looks like one of
//           the three is read by the language model, which names its kind and summarises it in a line. A cheap pattern
//           check comes first, so most messages never reach the model.
//   Close   A reply from someone else answers a question or request; a ✅ from its author closes it; a promise closes
//           only with a ✅, from the one who made it or the one it was made to (decision 30, DA-36).
//   Forget  A deleted message takes its item with it; /forget-me removes every item its author made.
// What: each item is a record named by its BLAKE3 label, and its closing is a record naming it.
import { labelOf } from './address.ts';
import type { Kernel } from './kernel.ts';
import type { Observed } from './memory.ts';
import type { Llm } from './providers.ts';
import { loopRecord, type SearchIndex } from './search.ts';
import type { Store } from './store.ts';

export type Kind = 'question' | 'promise' | 'request';
const KINDS: Record<Kind, number> = { question: 0, promise: 1, request: 2 };
export const CHECKS = new Set(['✅', '☑️', '✔️']);
const DAY = 86_400_000;

/** Worth asking the model about: a question mark, or the words a promise or a request is usually made with. */
export function candidate(text: string): boolean {
  const t = text.toLowerCase();
  if (t.length < 12 || t.length > 2000) return false;
  return /\?/.test(t)
    || /\b(i'll|i will|i'm going to|we'll|we will|let me|i can|i'll try to|will (send|share|post|push|review|fix|check|look|write|do|get))\b/.test(t)
    || /\b(can (someone|anyone|you)|could (someone|anyone|you)|would (someone|anyone|you)|please|anyone (know|have|able)|is there (a|any) way|looking for|need (help|someone))\b/.test(t);
}

export const TRACK_PROMPT = `You read one message from a community chat, with the messages just before it in the same place, and say whether that one message is something that needs follow-up. Reply with exactly one JSON object and nothing else:
{"kind":"question"|"promise"|"request"|null,"summary":"<one short line, in third person, without names>","due":"YYYY-MM-DD"|null}
Track only what a community manager would regret missing. When in doubt, answer null.
The earlier messages are context only: use them to tell what the message refers to and whether it is a real follow-up, never to track something said in them. A message whose object stays unclear even with them ("i will assemble it") is null.
- question: a substantive question the writer needs answered by someone else: about the UOR Foundation, its projects, its tools, how to contribute, or help with a concrete problem. Not rhetorical, not small talk or banter ("how are you?", "isn't it?"), not a question to the bot Q, not a question that is part of a casual exchange between two people.
- promise: the writer commits, without conditions, to deliver something concrete that others are waiting for (send, share, fix, review, write, publish, deliver), with or without a date. A personal plan nobody is waiting on, a figurative or emotional line, a vague intention or soft offer ("I'll see what I can do", "I can adapt it, stay tuned"), an offer that depends on someone else's approval, or a warning made in a dispute ("I'll address this") is not a promise.
- request: the writer asks others to do something specific or for help with something specific.
- null: anything else, including jokes, thanks, opinions, figurative lines, personal plans, and questions already answered in the same message. Also null: a rhetorical, sarcastic, argumentative or accusing line, or part of a dispute; a quick clarifying question inside a back-and-forth ("what do you mean?", "so you're looking for a tutorial?", "that needs X though, no?"); a poll or call for opinions (names, slogans, mascots); a jab or demand without a specific task ("make something real"); restating someone's point to check it ("so saying it back…") when it asks nothing new; personal chatter (accounts, subscriptions, credits, games).
- due: only when the message names a date or day; resolve it against today's date given below.`;

/** What the model reads for one message: today's date, the few messages before it in the same place, and the message. */
export function trackInput(today: string, earlier: readonly { author: string; text: string }[], writer: string, text: string): string {
  const names = new Map<string, string>([[writer, 'writer']]);
  const name = (a: string) => { if (!names.has(a)) names.set(a, String.fromCharCode(64 + names.size)); return names.get(a)!; };
  const before = earlier.map((m) => `- ${name(m.author)}: ${m.text.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n');
  return `Today is ${today}.\n\nEarlier in the same place, oldest first:\n${before || '(none)'}\n\nMessage: ${text.slice(0, 1500)}`;
}

/** How many earlier messages a message is read with. */
const CONTEXT = 6;

export const ANSWER_PROMPT = `You read a new chat message and a short list of open questions and requests from the same conversation. Say which items the new message answers or resolves: it gives the answer, the help asked for, or a clear pointer to it. A message that only acknowledges, asks more, or changes the subject resolves nothing. Reply with exactly one JSON object: {"answers":[<item numbers>]}, an empty list when it resolves none.`;

export interface Item { label: string; kind: Kind; url: string; channel: string; author: string; summary: string; due: string | null; at: number; closed: string | null }

export interface TrackerDeps {
  kernel: Kernel;
  store: Store;
  index: SearchIndex;
  llm: Llm;
  now(): number;
  /** The servers whose messages are tracked; null tracks every server. */
  guilds: ReadonlySet<string> | null;
}

const guildOf = (url: string) => /discord\.com\/channels\/(\d+)\//.exec(url)?.[1] ?? '';

export class Tracker {
  #deps: TrackerDeps;
  /** The last few messages Q may keep in each channel or thread, so a message is read in its conversation. */
  #recent = new Map<string, { author: string; text: string }[]>();
  constructor(deps: TrackerDeps) { this.#deps = deps; }

  #open(url: string | undefined): Item | undefined {
    if (!url) return undefined;
    const item = this.#deps.index.loopGet<Item>('tracked', url);
    return item && !item.closed ? item : undefined;
  }

  async #close(item: Item, by: string, how: 'reply' | 'check', human: boolean): Promise<boolean> {
    const decision = await this.#deps.kernel.closeItem(item.kind, how, by === item.author, human);
    if (decision !== 'close') return false;
    const record = { type: 'tracked-close', spec: 'uor-q/tracked-close/1', item: item.label, url: item.url, author: by, how, at: this.#deps.now() };
    const label = await this.#deps.store.put('private', record);
    await this.#deps.store.link('private', { source: label, target: item.label, relation: 'refers-to' });
    loopRecord(this.#deps.index, label, record);
    return true;
  }

  /** Open items a message may answer: in the same channel or thread, made by someone else in the last twelve hours. */
  #nearby(message: Observed): Item[] {
    const place = message.threadId ?? message.channelId;
    return this.#deps.index.loopAll<Item>('tracked').map((r) => r.value)
      .filter((i) => !i.closed && i.channel === place && i.author !== message.authorId && i.kind !== 'promise' && message.createdMs - i.at < 12 * 3_600_000 && message.createdMs > i.at)
      .slice(-5);
  }

  /**
   * People answer without using Discord's reply. The model reads the message against the open items near it and says
   * which, if any, it answers; each is then closed as a reply, as decision 30 allows.
   */
  async #answers(message: Observed): Promise<Item[]> {
    const near = this.#nearby(message);
    if (!near.length || message.text.trim().length < 15) return [];
    const list = near.map((i, n) => `${n + 1}. (${i.kind}) ${i.summary}`).join('\n');
    try {
      const reply = await this.#deps.llm.complete(ANSWER_PROMPT, `Open items:\n${list}\n\nNew message: ${message.text.slice(0, 1500)}`);
      const picked = JSON.parse(reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1)) as { answers?: number[] };
      return (picked.answers ?? []).filter((n) => Number.isInteger(n) && n >= 1 && n <= near.length).map((n) => near[n - 1]);
    } catch {
      return [];
    }
  }

  /** A message Q was offered. A reply may close what it answers; a new question, promise or request is caught. */
  async observed(message: Observed, decision: 'index' | 'skip'): Promise<'closed' | 'tracked' | undefined> {
    const { guilds } = this.#deps;
    if (guilds && !guilds.has(guildOf(message.url))) return undefined;
    // Only what Q may read and keep: a public channel, a human who has not opted out (decision 2).
    if (decision !== 'index') return undefined;
    const place = message.threadId ?? message.channelId;
    const earlier = this.#recent.get(place) ?? [];
    this.#recent.set(place, [...earlier, { author: message.authorId, text: message.text }].slice(-CONTEXT));
    const answered = this.#open(message.replyTo);
    if (answered && (await this.#close(answered, message.authorId, 'reply', message.origin === 'conversation'))) return 'closed';
    if (message.origin !== 'conversation') return undefined;
    let closedAny = false;
    for (const item of await this.#answers(message)) if (await this.#close(item, message.authorId, 'reply', true)) closedAny = true;
    if (!candidate(message.text)) return closedAny ? 'closed' : undefined;
    const today = new Date(this.#deps.now()).toISOString().slice(0, 10);
    let read: { kind: Kind | null; summary?: string; due?: string | null };
    try {
      const reply = await this.#deps.llm.complete(TRACK_PROMPT, trackInput(today, earlier, message.authorId, message.text));
      read = JSON.parse(reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1));
    } catch {
      return undefined;
    }
    if (!read.kind || !(read.kind in KINDS) || !read.summary?.trim()) return undefined;
    const due = typeof read.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(read.due) ? read.due : null;
    const record = { type: 'tracked', spec: 'uor-q/tracked/1', kind: read.kind, url: message.url, channel: message.threadId ?? message.channelId, author: message.authorId, summary: read.summary.trim().slice(0, 200), due, at: message.createdMs };
    const label = await this.#deps.store.put('private', record);
    loopRecord(this.#deps.index, label, record);
    return 'tracked';
  }

  /** A reaction: a ✅ on an open item may close it. */
  async reacted(url: string, emoji: string | null, by: string, human: boolean): Promise<'closed' | undefined> {
    const item = this.#open(url);
    if (!item || !CHECKS.has(emoji ?? '')) return undefined;
    return (await this.#close(item, by, 'check', human)) ? 'closed' : undefined;
  }

  /** A deleted message takes its item with it. */
  async withdraw(url: string) {
    const item = this.#deps.index.loopGet<Item>('tracked', url);
    if (!item) return;
    await this.#deps.store.delete('private', item.label);
    this.#deps.index.loopDelete('tracked', url);
  }

  /** What is still open, oldest first, in one server or in all; an item its author has since been forgotten for is left out. */
  async open(guild?: string): Promise<Item[]> {
    const items: Item[] = [];
    for (const { value } of this.#deps.index.loopAll<Item>('tracked')) {
      if (value.closed || (guild && guildOf(value.url) !== guild)) continue;
      if (await this.#deps.store.has('private', value.label)) items.push(value);
    }
    return items.sort((a, b) => a.at - b.at);
  }

  /** The open items as an admin reads them: by kind, oldest first, each linked to its message. */
  async summary(title: (url: string) => string, limit = 20, guild?: string): Promise<string> {
    const items = await this.open(guild);
    if (!items.length) return 'Nothing open: every tracked question, promise and request has been answered or kept.';
    const now = this.#deps.now();
    const age = (at: number) => { const d = Math.floor((now - at) / DAY); return d === 0 ? 'today' : d === 1 ? '1 day' : `${d} days`; };
    const counts = (['question', 'promise', 'request'] as Kind[]).map((k) => `${items.filter((i) => i.kind === k).length} ${k}${items.filter((i) => i.kind === k).length === 1 ? '' : 's'}`);
    const lines = [`**Open:** ${counts.join(', ')}.`];
    for (const kind of ['question', 'promise', 'request'] as Kind[]) {
      const these = items.filter((i) => i.kind === kind).slice(0, limit);
      if (!these.length) continue;
      lines.push('', `**${kind[0].toUpperCase()}${kind.slice(1)}s**`);
      for (const i of these) {
        const due = i.due ? ` · due ${i.due}${i.due < new Date(now).toISOString().slice(0, 10) ? ', overdue' : ''}` : '';
        lines.push(`- ${i.summary} · <@${i.author}> · ${age(i.at)}${due} · [${title(i.url)}](<${i.url}>)`);
      }
    }
    return lines.join('\n');
  }

  /** The label of the item at a message, for tests and the review. */
  static key(url: string) { return labelOf({ type: 'tracked-key', url }); }
}
