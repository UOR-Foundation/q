// One message in, at most one reply out. Each stage asks the kernel and obeys:
// a branch here follows an answer the kernel gave, and decides nothing of its own.
import { isLabel, labelOf, matches, type Item } from './address.ts';
import { areaOf, titleOf } from './titles.ts';
import { accepts, describe, type Decider } from './community.ts';
import type { ChannelFacts, CommandName, Kernel, Level, SourceName, Surface } from './kernel.ts';
import type { Memory } from './memory.ts';
import type { Embedder, Llm, ToolCall } from './providers.ts';
import { answer, context, event, manifest, normalize, pinOf, questionKey, webAnswer, type Answer, type CloudEvent, type Context, type DecisionAsked, type Manifest, type ToolUse, type WebAnswer, type WebSource } from './records.ts';
import type { SearchIndex } from './search.ts';
import type { Tools } from './tools.ts';
import { isRevoked, type Namespace, type Store } from './store.ts';
import { possibleFocusQuestion, renderFocus } from './focus-answer.ts';
import type { runFocus } from './focus-entry.ts';
import { capabilityReport, capabilityDetail, renderCapabilities, summarizeCapabilities } from './capabilities.ts';

export interface Incoming {
  /** The Discord channel's facts; absent on the MCP surface, which has no channel. */
  channel?: ChannelFacts;
  channelId: string;
  /** The server the message or command came from; absent in a direct message and off Discord. */
  guildId?: string;
  authorId: string;
  role: 'member' | 'admin';
  trigger: 'none' | 'mention' | 'replyToAgent' | 'slash';
  command?: CommandName;
  text: string;
  /** Called once the kernel has decided to answer, so the platform can show that Q is working. */
  working?: () => void;
  /** Called as the answer takes shape, for a platform that can show it: the sources found, then the words as they are written. */
  progress?: (event: Progress) => void;
  /** Where the question came from. Discord unless the agent's own MCP server or the website asked. */
  surface?: Surface;
  /** A command's other options, by name: /feedback's kind. */
  options?: Record<string, string>;
  /** A line of status while a long command runs (/build): the platform shows it to the person who asked. */
  status?: (text: string) => void;
  /** On the website: whether the answer is written to be read or to be heard. Written unless said. */
  register?: Register;
  /** On the website: the question keys of the earlier answers of this conversation, oldest first. The kernel admits each one or skips it (decision 31). */
  after?: readonly string[];
  /** Aborts when nobody is waiting for the answer any more: the model call is given up and no answer is recorded. */
  signal?: AbortSignal;
}

/** How an answer on the website is written: to be read on the page, or to be heard. Each has its own prompt, so its own manifest and keys. */
export type Register = 'written' | 'spoken';

/** A stage of one answer that a platform may show before the answer is whole. Never anything the kernel has not admitted. */
export type Progress =
  | { stage: 'sources'; outcome: Answer['outcome']; sources: Omit<WebSource, 'cited'>[] }
  | { stage: 'text'; delta: string };

/** An answer as the website is given it, with the label of exactly that record. */
export interface Published { label: string; answer: WebAnswer }

/** One answered turn, as conversation history remembers it: labels and facts only, never text. */
interface Turn { author: string; channel: string; answer: string; context: string; created: number }

export interface Settings {
  userLimit: number;
  channelLimit: number;
  windowMs: number;
  /** Cosine similarity at or above which the best hit is in the medium or the high band. Measured, set by the operator. */
  mediumSimilarity: number;
  highSimilarity: number;
  retrieve: number;
  /** Which reviewed answer shape the prompt uses (STYLES): a gene the loop may evolve. Grounding never changes. */
  style: number;
  /** LangBot's access control: the mode, and the session list (channel ids, user ids, or * for every one). */
  access: { mode: 'blacklist' | 'whitelist'; list: ReadonlySet<string> };
  /** LangBot's content filter: where it applies, and the terms it looks for. */
  filter: { scope: 'both' | 'incoming' | 'outgoing'; terms: readonly string[] };
  /** LangBot's long-text strategy, for a reply over one Discord message and up to five. */
  longText: 'split' | 'file';
  /** LangBot's query pool: how many questions are worked on at once. */
  concurrency: number;
  /** LangBot's conversation history: how long an earlier turn can be context for a reply to Q. */
  historyMinutes: number;
}

export interface Citation { label: string; url: string; source: SourceName; level: Level; text: string }
interface Draft {
  text: string;
  decision: string;
  citations: Citation[];
  /** Milliseconds per stage of an answered or refused question. Durations only: no content. */
  timings?: Record<string, number>;
  /** The label of the answer record this turn left, when it left one. */
  answer?: string;
  /** The public area of knowledge nearest the question (titles.ts areaOf): its class for Q's competence. */
  area?: string;
  /** On the website: the public record of this answer, named by its question key. */
  web?: Published;
}

const SENTINEL = 'NO_ANSWER';

/**
 * Holds a model's words until they are known to be the answer. Two things can still take them back:
 * the answer may be discarded for one that states a decision, and a model that finds no answer says
 * so with one word that is never shown.
 */
function valve(emit: ((delta: string) => void) | undefined) {
  let held = '';
  let open = false;
  let dropped = false;
  let answering = false;
  const flush = () => {
    if (!emit || !open || dropped || !held) return;
    if (!answering) {
      const start = held.trimStart();
      if (SENTINEL.startsWith(start.slice(0, SENTINEL.length))) {
        if (start.length >= SENTINEL.length) dropped = true;
        return;
      }
      answering = true;
    }
    emit(held);
    held = '';
  };
  return {
    push(delta: string) { if (!dropped) { held += delta; flush(); } },
    open() { open = true; flush(); },
    drop() { dropped = true; held = ''; },
  };
}

/** Laps of one question through the pipeline, for the log. */
function stopwatch() {
  let last = performance.now();
  const laps: Record<string, number> = {};
  return {
    laps,
    lap(name: string) {
      const now = performance.now();
      laps[name] = (laps[name] ?? 0) + Math.round(now - last);
      last = now;
    },
  };
}
/** A reply, and how the kernel decided it is delivered. */
export interface Outgoing extends Draft { delivery: 'send' | 'split' | 'file' }

/**
 * The content filter's facts: whether a text holds a listed term, and the text with each one masked.
 * The kernel decides what that means at each stage.
 */
export function screen(text: string, terms: readonly string[], stage: 'incoming' | 'outgoing'): { level: 'pass' | 'masked' | 'block'; text: string } {
  let found = false;
  let masked = text;
  for (const term of terms) {
    const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    if (!pattern.test(masked)) continue;
    found = true;
    masked = masked.replace(pattern, (match) => '*'.repeat(match.length));
  }
  if (!found) return { level: 'pass', text };
  return stage === 'incoming' ? { level: 'block', text } : { level: 'masked', text: masked };
}

const DISCORD_LIMIT = 2000;
const sizeOf = (text: string) => (text.length <= DISCORD_LIMIT ? 'one' : text.length <= 5 * 1900 ? 'few' : 'many');

/** What the pipeline reaches beyond itself: the commands' effects, the community root, and the event sink. */
export interface Actions {
  memory: Memory;
  reindex(): Promise<string>;
  /** The community as currently pinned. A function, because /reindex may move the pin. */
  community(): Decider;
  /** Where each turn's public event goes. */
  emit(event: CloudEvent): void;
  /** The MCP tools offered to the language model, if any server is configured. */
  tools?(): Tools | undefined;
  /** Live public read effect; production supplies it, offline shadow runs do not. */
  focus?: typeof runFocus;
  /** Public-safe observations for the capability inventory. */
  capabilityRuntime?(): import('./capabilities.ts').CapabilityRuntime;
  /** What Q is learning and what it proposes: the latest review of the improvement loop (improve.ts). */
  improve?(): Promise<string>;
  /** The open questions, promises and requests the tracker holds (tracker.ts), for /open. */
  open?(guild: string): Promise<string>;
  /** Who Q is, from its latest self-model, for anyone who asks with /status (improve.ts introduction). */
  self?(): Promise<string>;
  /** A Discord channel's or thread's name, for a cited message's title. */
  channelName?(id: string): string | undefined;
  /** A member's feedback or request (improve.ts): recorded, merged with others like it, filed to the community. */
  feedback?(f: { kind: string; text: string; authorId: string; channelId: string }): Promise<string>;
  /** Build a Prism app from one prompt and publish it in its own holospace (apps.ts, builder-service.ts). */
  build?(b: { prompt: string; progress: (text: string) => void }): Promise<string>;
}

/** Builds take the builder's time: at most this many an hour, per person and per channel. */
const BUILDS_PER_PERSON = 3;
const BUILDS_PER_CHANNEL = 10;

const ROUTER = `You read a question for the inputs of one UOR Foundation community decision.
Reply with one JSON object and nothing else: {"app": "<name>", "inputs": {"<field>": "<value>"}}.
- Choose the app only if the question asks for what that app decides. Otherwise reply {"app": null}.
- Give a field only when the question states or plainly implies it, as one of its listed values or a whole number in its range.
- Leave out every field you would have to guess.`;

/** The decision, as the answer's writer is told it: a proved answer to restate, or the inputs still needed. */
function decisionBrief(decision: DecisionAsked | null, community: Decider): string {
  if (!decision) return '';
  const app = community.apps.get(decision.app)!;
  const read = Object.entries(decision.inputs).map(([field, value]) => `${field} = ${value}`).join(', ') || 'none';
  if (decision.answer) {
    return `\n\nDecision: the community's verified app "${app.title}" (${app.name}) answers "${decision.answer}" for these inputs, read from the question: ${read}. ` +
      'State this answer first and what it means for the reader. Say the inputs are your reading of the question, and can be corrected.';
  }
  const needed = app.fields.filter((f) => decision.missing.includes(f.name)).map(describe).join('; ');
  return `\n\nDecision: this question is decided by the community's verified app "${app.title}". The question does not say: ${needed}. ` +
    'Answer what the sources allow, then ask the reader for exactly these, in one short list.';
}

const GROUNDING = `You are Q, the UOR Foundation's assistant on its Discord server. You answer the community's questions.

Grounding:
- Use only the numbered sources. Cite each claim right after it, as [1] or [1][2].
- If the sources do not answer the question, reply with exactly NO_ANSWER and nothing else.
- A source marked "open" is conversation, not established fact. Say so when you rely on one.
- Never invent or change a command, flag, number or link. Copy links exactly as the sources give them.

`;

/**
 * The answer shapes the loop may choose between: the prompt's one evolvable part, written and reviewed by people.
 * Q never writes a shape; it measures these on its tests and probes and keeps one only when decision 28 promotes it.
 * The first is the original shape, so its prompt label, and every answer key made with it, is unchanged.
 */
export const STYLES = [
  `Shape every answer like this, without naming the parts:
1. Open with the direct answer in one or two sentences, including why it matters.
2. Then explain how it works, in a few short steps.
3. End with something concrete the reader can use: an example, a command or a link.`,
  `Shape every answer like this, without naming the parts:
1. Give the direct answer in at most three sentences.
2. End with one concrete thing the reader can use: a command, an example or a link.`,
  `Shape every answer like this, without naming the parts:
1. Open with the direct answer in one sentence.
2. If the question asks how to do something, give the steps as a short list; otherwise explain how it works in a few sentences.
3. End with something concrete the reader can use: an example, a command or a link.`,
] as const;

const READER = `

Write for a reader who knows nothing about UOR or Prism:
- Define every technical term in a few words the first time it appears, such as "a holo (a packaged app that checks itself)". Leave out a term you cannot define briefly.
- Use short sentences and plain words. No hype and no filler.
- No preamble such as "Based on the sources", and no closing summary.

Format for Discord:
- Stay under 1,200 characters.
- Use **bold** for at most two key terms. No headings.
- Lists use "- ", one line per item, five items at most, never nested.
- Put commands, file names and code in \`backticks\`, and multi-line commands in a code block.
- Leave a blank line between paragraphs and before a list.`;

const styleOf = (style: number) => STYLES[Math.min(STYLES.length - 1, Math.max(0, Math.trunc(style || 0)))];
export const systemFor = (style: number) => `${GROUNDING}${styleOf(style)}${READER}`;

/** The prompts, by their BLAKE3 label: part of every answer key, so changing a prompt computes answers anew. */
export const promptOf = (style: number) => labelOf({ type: 'prompt', system: systemFor(style), router: ROUTER });

/**
 * The same grounding, written to be heard: a visitor to the website talks with Q and hears the answer.
 * The numbered citations stay in the text, where the page shows them; a voice does not read them out.
 */
const SYSTEM_SPOKEN = `You are Q, the UOR Foundation's agent, speaking aloud with a visitor on its website. Your words are heard, not read.

Grounding:
- Use only the numbered sources. Cite each claim right after it, as [1] or [1][2]. The listener sees the citations on the page and does not hear them.
- If the sources do not answer the question, reply with exactly NO_ANSWER and nothing else.
- A source marked "open" is conversation, not established fact. Say so when you rely on one.
- Never invent or change a command, flag, number or link.

Say it the way a person who knows the subject says it:
- Two to four short sentences, at most 450 characters.
- The first sentence is the direct answer, in under 20 words.
- Plain spoken words only: no markdown, no lists, no code blocks, no backticks, no links and no URLs. Say where to look in words, such as "the Prism docs".
- Define a technical term in a few words the first time it appears. Leave out a term you cannot define briefly.
- A dry touch of wit is welcome when it costs no accuracy, and never in place of the answer.
- No preamble, no closing summary, and no offer of further help.`;

const PROMPT_SPOKEN = labelOf({ type: 'prompt', system: SYSTEM_SPOKEN, router: ROUTER });
/** Each register's prompt and its label. The written one has the shape the loop currently keeps; the spoken one has one shape, which the loop does not choose. */
const promptsOf = (style: number): Record<Register, { system: string; label: string }> => ({ written: { system: systemFor(style), label: promptOf(style) }, spoken: { system: SYSTEM_SPOKEN, label: PROMPT_SPOKEN } });
const REGISTERS = ['written', 'spoken'] as const;

/** An earlier answer of a conversation on the website, as the kernel admitted it: its key, its record's label, and its words. */
interface Earlier { key: string; answer: string; text: string }
/** How much of the newest earlier answer retrieval reads beside a follow-up, which alone often names nothing to look for. */
const THREAD_QUERY = 300;
/** How much of each earlier answer the writer is given, as on Discord. */
const HISTORY_TEXT = 1500;

const QUERY_LIMIT = 1000;
const PROMPT_QUESTION_LIMIT = 4000;

/** The sources the answer cites by number, or all of them when it cites none: the reader still sees what it was given. */
const citedIn = (body: string, count: number): boolean[] => {
  const cited = new Set([...body.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]) - 1));
  return Array.from({ length: count }, (_, i) => cited.size === 0 || cited.has(i));
};

export class Pipeline {
  kernel: Kernel;
  store: Store;
  index: SearchIndex;
  embedder: Embedder;
  llm: Llm;
  settings: Settings;
  actions: Actions;
  now: () => number;
  /** How often each decision was reached. Counts only: no content, no author. */
  readonly metrics = new Map<string, number>();
  #user = new Map<string, number[]>();
  #channel = new Map<string, number[]>();

  constructor(kernel: Kernel, store: Store, index: SearchIndex, embedder: Embedder, llm: Llm, settings: Settings, actions: Actions, now: () => number = Date.now) {
    this.kernel = kernel; this.store = store; this.index = index; this.embedder = embedder; this.llm = llm; this.settings = settings; this.actions = actions; this.now = now;
  }

  #recent(log: Map<string, number[]>, key: string): number[] {
    const kept = (log.get(key) ?? []).filter((at) => at > this.now() - this.settings.windowMs);
    log.set(key, kept);
    return kept;
  }

  #running = 0;
  #waiting: (() => void)[] = [];

  #sessions = new Map<string, Promise<unknown>>();
  #builds = new Map<string, number[]>();

  /** Questions being worked on or waiting: a chaos experiment yields whenever a real one is here. */
  get load(): number {
    return this.#running + this.#waiting.length;
  }

  /** LangBot's controller: one question at a time per session (a person in a channel), then the global pool. */
  handle(message: Incoming): Promise<Outgoing | undefined> {
    const session = `${message.surface ?? 'discord'}:${message.channelId}:${message.authorId}`;
    const before = this.#sessions.get(session) ?? Promise.resolve();
    const run = before.catch(() => {}).then(() => this.#pooled(message));
    this.#sessions.set(session, run);
    run.finally(() => { if (this.#sessions.get(session) === run) this.#sessions.delete(session); }).catch(() => {});
    return run;
  }

  async #pooled(message: Incoming): Promise<Outgoing | undefined> {
    // The query pool: past the concurrency limit, a question waits its turn.
    if (this.#running >= Math.max(1, this.settings.concurrency)) await new Promise<void>((resolve) => this.#waiting.push(resolve));
    this.#running++;
    try {
      const draft = await this.#decide(message);
      const decision = draft?.decision ?? 'silent';
      this.metrics.set(decision, (this.metrics.get(decision) ?? 0) + 1);
      if (!draft) return undefined;
      // Outgoing content filter, then long-text delivery: both the kernel's to decide.
      const screened = screen(draft.text, this.settings.filter.terms, 'outgoing');
      const outgoing = await this.kernel.filter('outgoing', this.settings.filter.scope, screened.level);
      const text = outgoing === 'interrupt' ? "I can't send that answer." : outgoing === 'masked' ? screened.text : draft.text;
      return { ...draft, text, delivery: await this.kernel.length(sizeOf(text), this.settings.longText) };
    } finally {
      this.#running--;
      this.#waiting.shift()?.();
    }
  }

  async #decide(message: Incoming): Promise<Draft | undefined> {
    // A question given up while it waited its turn is not asked: it counts against no limit and leaves no record.
    message.signal?.throwIfAborted();
    // The reply rule is about Discord channels; a client of Q's own MCP server is answered on that surface,
    // where the exposure decision keeps every private item out.
    const surface = message.surface ?? 'discord';
    if (surface === 'discord' && (!message.channel || (await this.kernel.reply(message.channel, message.trigger)) === 'silent')) return undefined;

    // LangBot's access control, then its incoming content filter.
    const onList = ['*', message.channelId, message.authorId].some((id) => this.settings.access.list.has(id));
    if ((await this.kernel.access(this.settings.access.mode, onList)) === 'ignore') return undefined;
    const incoming = screen(message.text, this.settings.filter.terms, 'incoming');
    if ((await this.kernel.filter('incoming', this.settings.filter.scope, incoming.level)) === 'interrupt') {
      return { text: 'Not processed: the message holds content this server filters.', decision: 'interrupt', citations: [] };
    }

    const capabilityRequest = surface === 'discord' && (message.command ?? 'ask') === 'ask' ? capabilityDetail(message.text) : null;
    const command = capabilityRequest ? 'status' : (message.command ?? 'ask');
    const authorized = capabilityRequest && (await this.kernel.command('ask', message.role)) !== 'allowed'
      ? 'not authorized' : await this.kernel.command(command, message.role);
    if (authorized === 'not authorized') return { text: 'Not authorized: that command needs the admin role.', decision: authorized, citations: [] };

    const user = this.#recent(this.#user, message.authorId);
    const channel = this.#recent(this.#channel, message.channelId);
    const rate = await this.kernel.rate(user.length, this.settings.userLimit, channel.length, this.settings.channelLimit);
    if (rate === 'rate limited') return { text: 'Rate limited: try again in a minute.', decision: rate, citations: [] };
    user.push(this.now());
    channel.push(this.now());
    message.working?.();

    const done = (text: string): Draft => ({ text, decision: 'allowed', citations: [] });
    switch (command) {
      case 'status': {
        // Only the public report is served; ordinary status retains its
        // existing operational self-model. Nothing is retrieved or executed.
        const capabilities = surface === 'discord' && (await this.kernel.expose('public', surface)) === 'serve'
          ? (capabilityRequest === 'full' ? renderCapabilities : summarizeCapabilities)(await capabilityReport(this.kernel, this.actions.community(), this.actions, message.role))
          : '';
        if (capabilityRequest) return capabilities ? done(capabilities) : undefined;
        const counts = [...this.metrics.entries()].map(([name, count]) => `${name} ${count}`).join(', ') || 'none yet';
        const self = this.actions.self ? `\n\n${await this.actions.self()}` : '';
        return done(`Kernel model ${this.kernel.model}.\n${this.index.count()} chunks indexed.\nDecisions since start: ${counts}.${self}${capabilities ? '\n\n' + capabilities : ''}`);
      }
      case 'reindex':
        return done(await this.actions.reindex());
      case 'forget-channel':
        return done(`Forgot ${await this.actions.memory.forget({ channel: message.channelId })} items from this channel.`);
      case 'forget-me':
        return done(`Forgot ${await this.actions.memory.forget({ author: message.authorId })} items from you. Your messages will not be indexed from now on.`);
      case 'improve':
        return done(this.actions.improve ? await this.actions.improve() : 'The improvement loop is not running here.');
      case 'open':
        if (!this.actions.open) return done('Tracking is not switched on for this server.');
        // A server's open items are its own: /open shows only those of the server it is run in.
        return done(message.guildId ? await this.actions.open(message.guildId) : 'Run /open in a server.');
      case 'build': {
        if (!this.actions.build) return done('Building apps is not set up here.');
        if (!message.text.trim()) return done('Describe the app you want, for example: a tip advisor from how the service was and how large the party is.');
        const hour = this.now() - 3_600_000;
        const mine = (this.#builds.get(message.authorId) ?? []).filter((t) => t > hour);
        const here = (this.#builds.get(`#${message.channelId}`) ?? []).filter((t) => t > hour);
        if ((await this.kernel.rate(mine.length, BUILDS_PER_PERSON, here.length, BUILDS_PER_CHANNEL)) === 'rate limited') {
          return { text: `Rate limited: at most ${BUILDS_PER_PERSON} apps an hour each. Try again later.`, decision: 'rate limited', citations: [] };
        }
        this.#builds.set(message.authorId, [...mine, this.now()]);
        this.#builds.set(`#${message.channelId}`, [...here, this.now()]);
        return done(await this.actions.build({ prompt: message.text, progress: message.status ?? (() => {}) }));
      }
      case 'feedback':
        return done(this.actions.feedback
          ? await this.actions.feedback({ kind: message.options?.kind ?? 'idea', text: message.text, authorId: message.authorId, channelId: message.channelId })
          : 'Feedback is not collected here.');
    }

    if (!message.text.trim()) {
      return { text: 'Ask me a question about the UOR Foundation, for example: how do I start a Prism app?', decision: 'empty', citations: [] };
    }
    const clock = stopwatch();
    // The register and the conversation are the website's: elsewhere an answer is written, and history is decision 16's.
    const register: Register = surface === 'web' && command === 'ask' && message.register === 'spoken' ? 'spoken' : 'written';
    const thread = surface === 'web' && command === 'ask' && message.after?.length ? await this.#thread(message.after, register) : [];
    clock.lap('thread');
    message.signal?.throwIfAborted();
    // Retrieval reads the question's opening: past it, a longer question costs time and finds nothing more.
    // A follow-up is read together with the answer it follows, since "and how do I install it?" names nothing alone.
    const query = (thread.length ? `${thread.at(-1)!.text.slice(0, THREAD_QUERY)}\n${message.text}` : message.text).slice(0, QUERY_LIMIT);
    const [vector] = await this.embedder.embed([query], 'query');
    clock.lap('embed');
    // Retrieval looks only where the kernel serves on this surface: an item it would withhold takes no place among the hits.
    // The documentation and the conversation are searched apart, then joined: tens of thousands of Discord messages
    // would otherwise take every place, and an answer about UOR would be written from chat with no documentation in
    // view. Two thirds of the places go to the documentation when it has that many hits; the rest to the conversation.
    const served = await this.#served(surface);
    const retrieve = this.settings.retrieve;
    const documented = served.includes('public') ? this.index.search(query, vector, retrieve, ['public']) : [];
    const conversed = served.includes('private') ? this.index.search(query, vector, retrieve, ['private']) : [];
    const fromDocs = documented.slice(0, Math.max(retrieve - conversed.length, Math.ceil((retrieve * 2) / 3)));
    const hits = [...fromDocs, ...conversed.slice(0, retrieve - fromDocs.length)];
    clock.lap('search');

    // Read each hit back from the store and recompute its label; the kernel decides whether it may be cited.
    const citations: Citation[] = [];
    let best = 0;
    // The question's class: the public area of the nearest public item, whether or not it grounds an answer.
    let area: string | undefined;
    for (const hit of hits) {
      const item = await this.store.get(hit.namespace, hit.label);
      const verified = item !== undefined && matches(item, hit.label);
      const revoked = await isRevoked(this.store, hit.namespace, hit.label);
      if ((await this.kernel.cite(isLabel(hit.label), verified, revoked)) === 'drop') continue;
      if ((await this.kernel.expose(hit.namespace, surface)) === 'withhold') continue;
      if (!area && hit.namespace === 'public') area = areaOf(String(item!.url));
      citations.push({ label: hit.label, url: String(item!.url), source: item!.source as SourceName, level: item!.level as Level, text: String(item!.text) });
      best = Math.max(best, hit.similarity);
    }

    clock.lap('cite');
    const band = best >= this.settings.highSimilarity ? 'high' : best >= this.settings.mediumSimilarity ? 'medium' : 'low';
    const grounded = await this.kernel.ground(band, citations.length);
    const community = this.actions.community();
    const ordered = grounded === 'not grounded' ? [] : await this.#byTrust(citations);
    clock.lap('ground');
    message.progress?.({ stage: 'sources', outcome: grounded, sources: ordered.map((c, i) => ({ n: i + 1, label: c.label, url: c.url, source: c.source, level: c.level })) });

    // A potential live contribution question is decided before consulting a
    // memo. The existing community reader keeps precedence. Its parse errors,
    // unrecognized apps, and unresolved decisions are not a no-decision fact.
    // This first Discord slice returns a direct public diagnostic report (like
    // status), not an indexed answer or a persisted conversation turn.
    const focusCandidate = command === 'ask' && surface === 'discord' &&
      this.actions.focus !== undefined && possibleFocusQuestion(message.text);
    let focusCommunity: DecisionAsked | null | undefined;
    if (focusCandidate) {
      let noCommunity = false;
      focusCommunity = await this.#askCommunity(message.text, citations, community, message.signal, () => { noCommunity = true; });
      message.signal?.throwIfAborted();
      if (noCommunity && !focusCommunity && (await this.kernel.expose('public', surface)) === 'serve') {
        const fresh = await this.actions.focus!(this.kernel, this.llm, message.text,
          { admitted: true, community: 'not-applicable', scope: 'public' }, { signal: message.signal });
        message.signal?.throwIfAborted();
        if (fresh.kind === 'assessment') {
          clock.lap('focus');
          return { text: renderFocus(fresh.data), decision: 'allowed', citations: [], timings: clock.laps };
        }
        // A declined or unresolved live route must not masquerade as a fresh
        // recommendation from the ordinary indexed-answer path.
        if (fresh.kind === 'clarify') return done('Which one public UOR Foundation repository or contribution objective should I assess?');
        if (fresh.kind === 'hold' || fresh.kind === 'unavailable') return done('Live contribution assessment is unavailable; I cannot verify current work.');
      }
    }

    // Compute once. The same question on the same evidence, kernel, community, prompt and model is the
    // same computation: its key is the BLAKE3 label of exactly those, and a computed answer is reused.
    const namespace = await this.kernel.namespace('discord');
    // A reply to Q continues the conversation: the earlier turns the kernel admits are context, and part of the key.
    const history = grounded !== 'not grounded' && command === 'ask' && message.trigger === 'replyToAgent' ? await this.#history(message, namespace) : [];
    // On the website the earlier answers are the ones the visitor presented by key and the kernel admitted (decision 31).
    const built = [...history.map((h) => h.answer), ...thread.map((t) => t.answer)];
    const key = grounded !== 'not grounded' && command === 'ask' && !focusCandidate
      ? labelOf({ type: 'answer-key', question: normalize(message.text), kernel: this.kernel.holo, community: community.pin.holo, evidence: ordered.map((c) => c.label), history: built, prompt: promptsOf(this.settings.style)[register].label, model: this.llm.model })
      : null;
    const earlier = key ? await this.#recall(key, namespace) : undefined;
    clock.lap('memo');

    // The answer as the language model writes it, with a decision or without one.
    const used: ToolUse[] = [];
    const tools = this.actions.tools?.();
    const withTools = Boolean(tools?.list().length && this.llm.completeWithTools);
    // Words are shown as they are written only when the kernel would let every text the filter can produce go out unchanged.
    const shown = message.progress && !withTools && command === 'ask' && (await this.#unfiltered()) ? (delta: string) => message.progress!({ stage: 'text', delta }) : undefined;
    const compose = (decided: DecisionAsked | null, onText?: (delta: string) => void): Promise<string> => {
      const sources = ordered.map((c, i) => `[${i + 1}] (${c.source}, ${c.level}, ${c.url})\n${c.text}`).join('\n\n');
      // On the website only Q's own earlier answers are context, read from this host's store by their keys:
      // never text from the request, and never the question another visitor asked under the same key.
      const turns = [...history.map((h) => `Question: ${h.question}\nYour answer: ${h.text}`), ...thread.map((t) => `Your answer: ${t.text.slice(0, HISTORY_TEXT)}`)];
      const earlierTurns = turns.length ? `Earlier in this conversation (context for the question; cite only the sources):\n\n${turns.join('\n\n')}\n\n` : '';
      const prompt = `${earlierTurns}Sources:\n\n${sources}${decisionBrief(decided, community)}\n\nQuestion: ${message.text.slice(0, PROMPT_QUESTION_LIMIT)}`;
      const system = promptsOf(this.settings.style)[register].system;
      return withTools
        ? this.llm.completeWithTools!(system, prompt, tools!.list().map((t) => ({ name: t.qualified, description: `${t.description} (MCP server ${t.server})`, parameters: t.inputSchema })), (call) => this.#runTool(tools!, call, message, namespace, used))
        : this.llm.complete(system, prompt, onText, message.signal);
    };

    // Most questions that retrieve a decision app are not decisions. So the plain answer is written while
    // the decision's inputs are read, and kept when there is no decision: the reading then costs no time.
    // Never with tools: a tool call can have effects, and a discarded answer must have none.
    let speculative: Promise<string> | undefined;
    // The plain answer's words are held until it is known to be the answer, and dropped when it is not.
    const plain = valve(shown);
    let decision: DecisionAsked | null = earlier ? earlier.decision : null;
    if (!earlier && command === 'ask') {
      if (focusCommunity === undefined && !withTools && this.#candidates(ordered, community).length) {
        speculative = compose(null, plain.push);
        speculative.catch(() => {});
      }
      decision = focusCommunity === undefined ? await this.#askCommunity(message.text, ordered, community, message.signal) : focusCommunity;
    }
    clock.lap('decision');
    // Nobody is waiting any more: nothing of this turn is recorded.
    message.signal?.throwIfAborted();

    // The input record: everything this answer is made from, named by its label before anything is said.
    const turn = context({
      kernel: { holo: this.kernel.holo, model: this.kernel.model, commit: this.kernel.commit },
      community: pinOf(community.pin),
      request: { command, trigger: message.trigger, surface, question: message.text, ...(register === 'spoken' ? { register } : {}) },
      retrieval: { band, items: hits.map((hit) => hit.label) },
      history: built,
      decision,
      author: message.authorId, channel: message.channelId, created: this.now(),
    });
    const turnLabel = await this.store.put(namespace, turn);

    if (grounded === 'not grounded') {
      const text = "I don't know: nothing I have indexed answers that well enough to cite.";
      const said = answer({ context: turnLabel, outcome: grounded, level: null, text, citations: [], tools: [], memo: null, reused: null, author: message.authorId, channel: message.channelId, created: this.now() });
      const saidLabel = await this.#said(namespace, turn, turnLabel, said, []);
      const web = await this.#publish(message, turn, turnLabel, said, saidLabel, [], register, thread);
      clock.lap('record');
      return { text, decision: grounded, citations: [], timings: clock.laps, answer: saidLabel, web, area };
    }

    let level: Level = ordered[0].level;
    for (const citation of ordered.slice(1)) level = await this.kernel.level(level, citation.level);
    let body: string;
    if (earlier) {
      body = earlier.text;
    } else if (command === 'search') {
      body = ordered.map((c, i) => `[${i + 1}] ${c.text.slice(0, 200).replace(/\s+/g, ' ')}`).join('\n');
    } else if (speculative && !decision) {
      plain.open();
      body = await speculative;
    } else {
      plain.drop();
      const decided = valve(shown);
      decided.open();
      body = await compose(decision, decided.push);
    }
    clock.lap('answer');
    // An answer nobody waited for is not an answer of this conversation: it is not recorded, and not remembered under any key.
    message.signal?.throwIfAborted();

    // The writer read the sources and found no answer in them: say so plainly, with nothing that looks
    // like evidence for a claim that was not made.
    if (/^\s*NO_ANSWER\b/.test(body)) {
      const text = "I don't know: the sources I found do not answer that.";
      const said = answer({
        context: turnLabel, outcome: grounded, level: null, text, citations: [], tools: used,
        memo: key && used.length === 0 ? key : null, reused: earlier?.answer ?? null,
        author: message.authorId, channel: message.channelId, created: this.now(),
      });
      const saidLabel = await this.#said(namespace, turn, turnLabel, said, []);
      const web = await this.#publish(message, turn, turnLabel, said, saidLabel, [], register, thread);
      clock.lap('record');
      return { text, decision: 'declined', citations: [], timings: clock.laps, answer: saidLabel, web, area };
    }
    // A tool's result is measured, not established: an answer that used one is open at most.
    if (used.some((u) => u.result)) level = await this.kernel.level(level, 'open');
    // List only the sources the answer cites, keeping their numbers so inline references still match.
    const cited = citedIn(body, ordered.length);
    const listed = ordered.map((c, i) => ({ c, i })).filter(({ i }) => cited[i]);
    // Discord's subtext (-#) keeps the evidence visible without competing with the answer.
    // Each source is its link alone: the claim level above says how far the answer is established, and the full
    // record (source, level, BLAKE3 label) stays in the answer record, not in the reader's way.
    const name = (id: string) => this.actions.channelName?.(id);
    const sources = listed.map(({ c, i }) => `-# [${i + 1}] [${titleOf(c.url, name)}](<${c.url}>)`).join('\n');
    const notice = grounded === 'answer with notice' ? '\n\n*Low confidence: the sources only partly match the question.*' : '';
    const decided = decision?.answer
      ? `\n-# Decision: ${decision.app} → ${decision.answer} · proved in ${community.pin.commit.slice(0, 7)} of UOR-Foundation/community · holo ${community.pin.holo.slice(0, 15)} · inputs are Q's reading`
      : '';
    const toolLines = used.map((u) => (u.result ? `\n-# Tool: ${u.server}/${u.tool} · ${u.result.slice(0, 15)}` : `\n-# Tool refused: ${u.server}/${u.tool}`)).join('');
    const reusedLine = earlier ? `\n-# Answered once before for this exact question and evidence · ${earlier.answer.slice(0, 15)}` : '';
    const text = `${body}${notice}\n\n-# Claim level: ${level}${decided}${toolLines}${reusedLine}\n${sources}`;

    const said = answer({
      context: turnLabel, outcome: grounded, level, text: body, citations: ordered.map((c) => c.label), tools: used,
      // An answer that called a tool is never reused: a tool's result can change between calls.
      memo: key && used.length === 0 ? key : null, reused: earlier?.answer ?? null,
      author: message.authorId, channel: message.channelId, created: this.now(),
    });
    const saidLabel = await this.#said(namespace, turn, turnLabel, said, [...ordered.map((c) => c.label), ...used.flatMap((u) => (u.result ? [u.result] : []))]);
    const web = await this.#publish(message, turn, turnLabel, said, saidLabel, ordered, register, thread);
    clock.lap('record');
    return { text, decision: grounded, citations: ordered, timings: clock.laps, answer: saidLabel, web, area };
  }

  /** The namespaces the kernel serves on a surface (decision 17). */
  async #served(surface: Surface): Promise<Namespace[]> {
    const served: Namespace[] = [];
    for (const space of ['public', 'private'] as const) if ((await this.kernel.expose(space, surface)) === 'serve') served.push(space);
    return served;
  }

  /** Whether the outgoing filter can change no answer: the kernel lets through both a clean text and, if terms are set, one that holds a term. */
  async #unfiltered(): Promise<boolean> {
    const { scope, terms } = this.settings.filter;
    if ((await this.kernel.filter('outgoing', scope, 'pass')) !== 'continue') return false;
    return terms.length === 0 || (await this.kernel.filter('outgoing', scope, 'masked')) === 'continue';
  }

  #manifests?: { at: string; by: Record<Register, { label: string; manifest: Manifest }> };

  /**
   * Everything an answer on the website depends on besides the question and the answers before it, as one
   * record and its label. A change to the kernel, the community pin, the served index, the prompts or the
   * model is a new manifest, and with it a new key for every question. The two registers differ in their
   * prompt alone, so each has its own manifest and no key of one is a key of the other.
   */
  async manifest(register: Register = 'written'): Promise<{ label: string; manifest: Manifest }> {
    const community = this.actions.community();
    // The count as well as the revision: another process (an ingest) can add chunks this one never saw added.
    const at = `${this.index.revision}:${this.index.count()}:${community.pin.holo}:${community.pin.commit}`;
    if (this.#manifests?.at !== at) {
      const items = (await this.#served('web')).flatMap((space) => this.index.labels(space)).sort();
      const corpus = labelOf({ type: 'corpus', items });
      const made = (prompt: string) => {
        const record = manifest({
          kernel: { holo: this.kernel.holo, commit: this.kernel.commit },
          community: pinOf(community.pin),
          corpus,
          prompt,
          model: this.llm.model,
          retrieval: { embedder: this.embedder.model, retrieve: this.settings.retrieve, medium: String(this.settings.mediumSimilarity), high: String(this.settings.highSimilarity) },
        });
        return { label: labelOf(record), manifest: record };
      };
      const prompts = promptsOf(this.settings.style);
      this.#manifests = { at, by: { written: made(prompts.written.label), spoken: made(prompts.spoken.label) } };
      this.index.questionKeep(REGISTERS.map((each) => this.#manifests!.by[each].label));
    }
    return this.#manifests.by[register];
  }

  /**
   * A turn on the website, as its public record. An answer that called no tool is remembered under its
   * question key, so the same question after the same answers under the same manifest is read back
   * without retrieval or the model. The key holds the admitted earlier answers, so an answer with
   * history is never remembered under the key of its question alone.
   */
  async #publish(message: Incoming, turn: Context, turnLabel: string, said: Answer, saidLabel: string, ordered: Citation[], register: Register, thread: Earlier[]): Promise<Published | undefined> {
    if (message.surface !== 'web' || turn.request.command !== 'ask') return undefined;
    const { label } = await this.manifest(register);
    const after = thread.map((t) => t.key);
    const key = questionKey(message.text, label, after);
    if (said.tools.length === 0) this.index.questionSet(key, label, saidLabel, turnLabel, after);
    return this.#project(key, label, said, turn, ordered, after);
  }

  /** The public record of an answer: what a visitor is shown, and nothing of who asked or what they asked. */
  async #project(key: string, manifestLabel: string, said: Answer, turn: Context, sources: Pick<Citation, 'label' | 'url' | 'source' | 'level'>[], after: readonly string[]): Promise<Published> {
    // The outgoing content filter, as on every surface: the kernel decides what the filter's finding means.
    const screened = screen(said.text, this.settings.filter.terms, 'outgoing');
    const outgoing = await this.kernel.filter('outgoing', this.settings.filter.scope, screened.level);
    const text = outgoing === 'interrupt' ? "I can't send that answer." : outgoing === 'masked' ? screened.text : said.text;
    const cited = citedIn(said.text, sources.length);
    const record = webAnswer({
      key, manifest: manifestLabel, outcome: said.outcome, band: turn.retrieval.band, level: said.level, text,
      decision: turn.decision?.answer ? { app: turn.decision.app, answer: turn.decision.answer, commit: turn.community.commit } : null,
      sources: sources.map((c, i) => ({ n: i + 1, label: c.label, url: c.url, source: c.source, level: c.level, cited: cited[i] })),
      tools: said.tools.length, kernel: turn.kernel.holo, community: turn.community.holo, after: [...after],
    });
    return { label: labelOf(record), answer: record };
  }

  /**
   * The answer already computed for a question key, if there is one: no retrieval, no model, and no question
   * text, since the key is all that is asked. Each source is read back and decided again by the kernel, as it
   * was when the answer was written (10, 17); if any is no longer served, the answer is no longer known.
   * A key of either register is known: the key says which manifest it was asked under.
   */
  async lookup(key: string): Promise<Published | undefined> {
    const known = await this.#known(key);
    if (known) this.metrics.set('lookup', (this.metrics.get('lookup') ?? 0) + 1);
    return known?.published;
  }

  /** The answer a key names, with the label of its private record, which is never sent. */
  async #known(key: string): Promise<{ published: Published; answer: string } | undefined> {
    if (!isLabel(key)) return undefined;
    const row = this.index.questionGet(key);
    const current = await Promise.all(REGISTERS.map(async (register) => (await this.manifest(register)).label));
    if (!row || !current.includes(row.manifest)) return undefined;
    const forget = () => { this.index.questionDelete(key); return undefined; };
    const namespace = await this.kernel.namespace('discord');
    const said = await this.store.get(namespace, row.answer);
    const turn = await this.store.get(namespace, row.context);
    if (!said || !turn || said.type !== 'answer' || turn.type !== 'context' || !matches(said, row.answer) || !matches(turn, row.context)) return forget();
    const sources: Pick<Citation, 'label' | 'url' | 'source' | 'level'>[] = [];
    for (const cited of (said as Answer).citations) {
      const item = await this.item(cited);
      if (!item) return forget();
      sources.push({ label: cited, url: String(item.url), source: item.source as SourceName, level: item.level as Level });
    }
    return { published: await this.#project(key, row.manifest, said as Answer, turn as Context, sources, row.after), answer: row.answer };
  }

  /**
   * The earlier answers a question on the website may build on, oldest first. A visitor presents their keys;
   * the kernel decides each one (decision 31): it is context only when this host still reads it back by its
   * key under this register's manifest, as an answer that used no tool, and it is among the newest three
   * presented. The words come from this host's own store, never from the request.
   */
  async #thread(after: readonly string[], register: Register): Promise<Earlier[]> {
    const { label } = await this.manifest(register);
    const admitted: Earlier[] = [];
    for (const [place, key] of [...after].reverse().entries()) {
      const known = await this.#known(key);
      const answered = known !== undefined && known.published.answer.manifest === label && known.published.answer.tools === 0 && known.published.answer.level !== null;
      if ((await this.kernel.thread(answered, place < 3)) === 'use') admitted.unshift({ key, answer: known!.answer, text: known!.published.answer.text });
    }
    return admitted;
  }

  /**
   * One chunk as the website may read it: found where the kernel serves on the web (17), with its label
   * recomputed and the kernel's citation decision on it (10). A visitor can recompute the same label.
   */
  async item(label: string): Promise<Item | undefined> {
    if (!isLabel(label)) return undefined;
    for (const space of await this.#served('web')) {
      const item = await this.store.get(space, label);
      if (item?.type !== 'chunk') continue;
      if ((await this.kernel.cite(true, matches(item, label), await isRevoked(this.store, space, label))) === 'cite') return item;
    }
    return undefined;
  }

  /**
   * The output record and the public event. The answer names its context, its evidence and every holo
   * that judged it; the event carries counts only.
   */
  async #said(namespace: Namespace, turn: Context, turnLabel: string, said: Answer, evidence: string[]): Promise<string> {
    const label = await this.store.put(namespace, said);
    await this.store.link(namespace, { source: label, target: turnLabel, relation: 'derived-from' });
    if (said.reused) await this.store.link(namespace, { source: label, target: said.reused, relation: 'derived-from' });
    for (const target of evidence) await this.store.link(namespace, { source: label, target, relation: 'evidence-provenance' });
    await this.store.link(namespace, { source: label, target: turn.kernel.holo, relation: 'certified-by' });
    if (turn.decision?.answer) await this.store.link(namespace, { source: label, target: turn.community.holo, relation: 'certified-by' });
    // Computed now, and reusable: index it under its key, so the same question on the same evidence is answered once.
    if (said.memo && !said.reused) this.index.memoSet(said.memo, label, turnLabel);
    // An answer, not a refusal, can be context for a reply to it.
    if (said.level !== null) {
      const turns = this.#turns.get(said.channel) ?? [];
      turns.push({ author: said.author, channel: said.channel, answer: label, context: turnLabel, created: said.created });
      this.#turns.set(said.channel, turns.slice(-20));
    }
    this.actions.emit(event(turn, said));
    return label;
  }

  #turns = new Map<string, Turn[]>();

  /**
   * The earlier turns a reply to Q may build on, newest three at most. The kernel decides each one (decision 16);
   * a turn whose records were forgotten or no longer carry their labels is gone.
   */
  async #history(message: Incoming, namespace: Namespace): Promise<{ answer: string; question: string; text: string }[]> {
    const out: { answer: string; question: string; text: string }[] = [];
    const window = this.settings.historyMinutes * 60_000;
    for (const turn of [...(this.#turns.get(message.channelId) ?? [])].reverse()) {
      if (out.length >= 3) break;
      const allowed = await this.kernel.history(turn.author === message.authorId, turn.channel === message.channelId, this.now() - turn.created <= window);
      if (allowed === 'skip') continue;
      const said = await this.store.get(namespace, turn.answer);
      const turnRecord = await this.store.get(namespace, turn.context);
      if (!said || !turnRecord || !matches(said, turn.answer) || !matches(turnRecord, turn.context)) continue;
      const question = String((turnRecord.request as { question?: unknown } | undefined)?.question ?? '');
      out.unshift({ answer: turn.answer, question: question.slice(0, 600), text: String(said.text).slice(0, 1500) });
    }
    return out;
  }

  /**
   * An answer computed before for this key, when both its records still exist and still have their labels.
   * Forgetting an author deletes their records, and with them every reuse of their answers.
   */
  async #recall(key: string, namespace: Namespace): Promise<{ answer: string; text: string; decision: DecisionAsked | null } | undefined> {
    const row = this.index.memoGet(key);
    if (!row) return undefined;
    const said = await this.store.get(namespace, row.answer);
    const turn = await this.store.get(namespace, row.context);
    if (!said || !turn || !matches(said, row.answer) || !matches(turn, row.context) || said.memo !== key) {
      this.index.memoDelete(key);
      return undefined;
    }
    return { answer: row.answer, text: String(said.text), decision: (turn.decision ?? null) as DecisionAsked | null };
  }

  /**
   * One tool call the language model asked for. The kernel decides it; an allowed call's result is stored
   * as an item, named by its label, private and forgotten with the author whose question it served.
   */
  async #runTool(tools: Tools, call: ToolCall, message: Incoming, namespace: Namespace, used: ToolUse[]): Promise<string> {
    const tool = tools.find(call.name);
    if (!tool) return 'There is no tool by that name.';
    const decision = await this.kernel.tool(tool.allowlisted, tool.writes, message.role);
    if (decision === 'refuse') {
      used.push({ server: tool.server, tool: tool.name, decision, result: null });
      return 'Refused: this tool is not allowed here.';
    }
    const content = await tools.call(tool, call.arguments);
    const result = await this.store.put(namespace, {
      type: 'tool-result', server: tool.server, tool: tool.name, arguments: JSON.stringify(call.arguments), content,
      author: message.authorId, channel: message.channelId, created: this.now(),
    });
    used.push({ server: tool.server, tool: tool.name, decision, result });
    return content;
  }

  /**
   * When a retrieved source is one of the community's decision apps, read the question's inputs for it and
   * ask the community holo. The language model only reads inputs; the holo decides. Inputs it cannot read
   * from the question are named, not guessed.
   */
  /** The community decision apps among the cited sources. */
  #candidates(ordered: Citation[], community: Decider): string[] {
    const named = new Set<string>();
    for (const citation of ordered) {
      const app = /\/apps\/([a-z0-9-]+)\.prompt\.json$/.exec(citation.url)?.[1];
      if (app && community.apps.has(app)) named.add(app);
    }
    return [...named];
  }

  async #askCommunity(question: string, ordered: Citation[], community: Decider, signal?: AbortSignal, noDecision?: () => void): Promise<DecisionAsked | null> {
    const named = new Set(this.#candidates(ordered, community));
    if (!named.size) { noDecision?.(); return null; }
    const apps = [...named].map((name) => community.apps.get(name)!);
    const catalog = apps.map((app) => `${app.name}: ${app.purpose}\n${app.fields.map((f) => `  ${describe(f)}`).join('\n')}`).join('\n\n');
    const reply = await this.llm.complete(ROUTER, `Apps:\n\n${catalog}\n\nQuestion: ${question}`, undefined, signal);
    if (/^\s*\{\s*"app"\s*:\s*null\s*\}\s*$/.test(reply)) noDecision?.();
    let pick: { app?: unknown; inputs?: Record<string, unknown> };
    try {
      pick = JSON.parse(/\{[\s\S]*\}/.exec(reply)?.[0] ?? 'null') ?? {};
    } catch {
      return null;
    }
    const app = typeof pick.app === 'string' ? community.apps.get(pick.app) : undefined;
    if (!app || !named.has(app.name)) return null;
    const inputs: Record<string, string> = {};
    const missing: string[] = [];
    for (const field of app.fields) {
      const value = pick.inputs?.[field.name];
      if (accepts(field, value)) inputs[field.name] = value;
      else missing.push(field.name);
    }
    if (missing.length) return { app: app.name, inputs, missing, answer: null };
    return { app: app.name, inputs, missing, answer: await community.decide(app.name, app.fields.map((f) => inputs[f.name])) };
  }

  /** Most trusted source first, by asking the kernel which of each pair it prefers. */
  async #byTrust(citations: Citation[]): Promise<Citation[]> {
    const ordered: Citation[] = [];
    for (const citation of citations) {
      let at = ordered.length;
      while (at > 0 && ordered[at - 1].source !== citation.source && (await this.kernel.prefer(ordered[at - 1].source, citation.source)) === citation.source) at--;
      ordered.splice(at, 0, citation);
    }
    return ordered;
  }
}
