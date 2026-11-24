// One message in, at most one reply out. Each stage asks the kernel and obeys:
// a branch here follows an answer the kernel gave, and decides nothing of its own.
import { isLabel, labelOf, matches } from './address.ts';
import { accepts, describe, type Decider } from './community.ts';
import type { ChannelFacts, CommandName, Kernel, Level, SourceName } from './kernel.ts';
import type { Memory } from './memory.ts';
import type { Embedder, Llm, ToolCall } from './providers.ts';
import { answer, context, event, pinOf, type Answer, type CloudEvent, type Context, type DecisionAsked, type ToolUse } from './records.ts';
import type { SearchIndex } from './search.ts';
import type { Tools } from './tools.ts';
import { isRevoked, type Namespace, type Store } from './store.ts';

export interface Incoming {
  channel: ChannelFacts;
  channelId: string;
  authorId: string;
  role: 'member' | 'admin';
  trigger: 'none' | 'mention' | 'replyToAgent' | 'slash';
  command?: CommandName;
  text: string;
  /** Called once the kernel has decided to answer, so the platform can show that Q is working. */
  working?: () => void;
}

export interface Settings {
  userLimit: number;
  channelLimit: number;
  windowMs: number;
  /** Cosine similarity at or above which the best hit is in the medium or the high band. Measured, set by the operator. */
  mediumSimilarity: number;
  highSimilarity: number;
  retrieve: number;
  /** LangBot's access control: the mode, and the session list (channel ids, user ids, or * for every one). */
  access: { mode: 'blacklist' | 'whitelist'; list: ReadonlySet<string> };
  /** LangBot's content filter: where it applies, and the terms it looks for. */
  filter: { scope: 'both' | 'incoming' | 'outgoing'; terms: readonly string[] };
  /** LangBot's long-text strategy, for a reply over one Discord message and up to five. */
  longText: 'split' | 'file';
  /** LangBot's query pool: how many questions are worked on at once. */
  concurrency: number;
}

export interface Citation { label: string; url: string; source: SourceName; level: Level; text: string }
interface Draft {
  text: string;
  decision: string;
  citations: Citation[];
  /** Milliseconds per stage of an answered or refused question. Durations only: no content. */
  timings?: Record<string, number>;
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
}

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

const SYSTEM = `You are Q, the UOR Foundation's assistant on its Discord server. You answer the community's questions.

Grounding:
- Use only the numbered sources. Cite each claim right after it, as [1] or [1][2].
- If the sources do not answer the question, reply with exactly NO_ANSWER and nothing else.
- A source marked "open" is conversation, not established fact. Say so when you rely on one.
- Never invent or change a command, flag, number or link. Copy links exactly as the sources give them.

Shape every answer like this, without naming the parts:
1. Open with the direct answer in one or two sentences, including why it matters.
2. Then explain how it works, in a few short steps.
3. End with something concrete the reader can use: an example, a command or a link.

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

/** The prompts, by their BLAKE3 label: part of every answer key, so changing a prompt computes answers anew. */
const PROMPT = labelOf({ type: 'prompt', system: SYSTEM, router: ROUTER });

/** A question as its answer key reads it: the same words, whatever the case or spacing. */
const QUERY_LIMIT = 1000;
const PROMPT_QUESTION_LIMIT = 4000;

const normalize = (text: string) => text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();

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

  async handle(message: Incoming): Promise<Outgoing | undefined> {
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
    if ((await this.kernel.reply(message.channel, message.trigger)) === 'silent') return undefined;

    // LangBot's access control, then its incoming content filter.
    const onList = ['*', message.channelId, message.authorId].some((id) => this.settings.access.list.has(id));
    if ((await this.kernel.access(this.settings.access.mode, onList)) === 'ignore') return undefined;
    const incoming = screen(message.text, this.settings.filter.terms, 'incoming');
    if ((await this.kernel.filter('incoming', this.settings.filter.scope, incoming.level)) === 'interrupt') {
      return { text: 'Not processed: the message holds content this server filters.', decision: 'interrupt', citations: [] };
    }

    const command = message.command ?? 'ask';
    const authorized = await this.kernel.command(command, message.role);
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
        const counts = [...this.metrics.entries()].map(([name, count]) => `${name} ${count}`).join(', ') || 'none yet';
        return done(`Kernel model ${this.kernel.model}.\n${this.index.count()} chunks indexed.\nDecisions since start: ${counts}.`);
      }
      case 'reindex':
        return done(await this.actions.reindex());
      case 'forget-channel':
        return done(`Forgot ${await this.actions.memory.forget({ channel: message.channelId })} items from this channel.`);
      case 'forget-me':
        return done(`Forgot ${await this.actions.memory.forget({ author: message.authorId })} items from you. Your messages will not be indexed from now on.`);
    }

    if (!message.text.trim()) {
      return { text: 'Ask me a question about the UOR Foundation, for example: how do I start a Prism app?', decision: 'empty', citations: [] };
    }
    const clock = stopwatch();
    // Retrieval reads the question's opening: past it, a longer question costs time and finds nothing more.
    const query = message.text.slice(0, QUERY_LIMIT);
    const [vector] = await this.embedder.embed([query], 'query');
    clock.lap('embed');
    const hits = this.index.search(query, vector, this.settings.retrieve);
    clock.lap('search');

    // Read each hit back from the store and recompute its label; the kernel decides whether it may be cited.
    const citations: Citation[] = [];
    let best = 0;
    for (const hit of hits) {
      const item = await this.store.get(hit.namespace, hit.label);
      const verified = item !== undefined && matches(item, hit.label);
      const revoked = await isRevoked(this.store, hit.namespace, hit.label);
      if ((await this.kernel.cite(isLabel(hit.label), verified, revoked)) === 'drop') continue;
      citations.push({ label: hit.label, url: String(item!.url), source: item!.source as SourceName, level: item!.level as Level, text: String(item!.text) });
      best = Math.max(best, hit.similarity);
    }

    clock.lap('cite');
    const band = best >= this.settings.highSimilarity ? 'high' : best >= this.settings.mediumSimilarity ? 'medium' : 'low';
    const grounded = await this.kernel.ground(band, citations.length);
    const community = this.actions.community();
    const ordered = grounded === 'not grounded' ? [] : await this.#byTrust(citations);
    clock.lap('ground');

    // Compute once. The same question on the same evidence, kernel, community, prompt and model is the
    // same computation: its key is the BLAKE3 label of exactly those, and a computed answer is reused.
    const namespace = await this.kernel.namespace('discord');
    const key = grounded !== 'not grounded' && command === 'ask'
      ? labelOf({ type: 'answer-key', question: normalize(message.text), kernel: this.kernel.holo, community: community.pin.holo, evidence: ordered.map((c) => c.label), prompt: PROMPT, model: this.llm.model })
      : null;
    const earlier = key ? await this.#recall(key, namespace) : undefined;
    clock.lap('memo');

    // The answer as the language model writes it, with a decision or without one.
    const used: ToolUse[] = [];
    const tools = this.actions.tools?.();
    const withTools = Boolean(tools?.list().length && this.llm.completeWithTools);
    const compose = (decided: DecisionAsked | null): Promise<string> => {
      const sources = ordered.map((c, i) => `[${i + 1}] (${c.source}, ${c.level}, ${c.url})\n${c.text}`).join('\n\n');
      const prompt = `Sources:\n\n${sources}${decisionBrief(decided, community)}\n\nQuestion: ${message.text.slice(0, PROMPT_QUESTION_LIMIT)}`;
      return withTools
        ? this.llm.completeWithTools!(SYSTEM, prompt, tools!.list().map((t) => ({ name: t.qualified, description: `${t.description} (MCP server ${t.server})`, parameters: t.inputSchema })), (call) => this.#runTool(tools!, call, message, namespace, used))
        : this.llm.complete(SYSTEM, prompt);
    };

    // Most questions that retrieve a decision app are not decisions. So the plain answer is written while
    // the decision's inputs are read, and kept when there is no decision: the reading then costs no time.
    // Never with tools: a tool call can have effects, and a discarded answer must have none.
    let speculative: Promise<string> | undefined;
    let decision: DecisionAsked | null = earlier ? earlier.decision : null;
    if (!earlier && command === 'ask') {
      if (!withTools && this.#candidates(ordered, community).length) {
        speculative = compose(null);
        speculative.catch(() => {});
      }
      decision = await this.#askCommunity(message.text, ordered, community);
    }
    clock.lap('decision');

    // The input record: everything this answer is made from, named by its label before anything is said.
    const turn = context({
      kernel: { holo: this.kernel.holo, model: this.kernel.model, commit: this.kernel.commit },
      community: pinOf(community.pin),
      request: { command, trigger: message.trigger, question: message.text },
      retrieval: { band, items: hits.map((hit) => hit.label) },
      decision,
      author: message.authorId, channel: message.channelId, created: this.now(),
    });
    const turnLabel = await this.store.put(namespace, turn);

    if (grounded === 'not grounded') {
      const text = "I don't know: nothing I have indexed answers that well enough to cite.";
      await this.#said(namespace, turn, turnLabel, answer({ context: turnLabel, outcome: grounded, level: null, text, citations: [], tools: [], memo: null, reused: null, author: message.authorId, channel: message.channelId, created: this.now() }), []);
      clock.lap('record');
      return { text, decision: grounded, citations: [], timings: clock.laps };
    }

    let level: Level = ordered[0].level;
    for (const citation of ordered.slice(1)) level = await this.kernel.level(level, citation.level);
    let body: string;
    if (earlier) {
      body = earlier.text;
    } else if (command === 'search') {
      body = ordered.map((c, i) => `[${i + 1}] ${c.text.slice(0, 200).replace(/\s+/g, ' ')}`).join('\n');
    } else {
      body = speculative && !decision ? await speculative : await compose(decision);
    }
    clock.lap('answer');

    // The writer read the sources and found no answer in them: say so plainly, with nothing that looks
    // like evidence for a claim that was not made.
    if (/^\s*NO_ANSWER\b/.test(body)) {
      const text = "I don't know: the sources I found do not answer that.";
      await this.#said(namespace, turn, turnLabel, answer({
        context: turnLabel, outcome: grounded, level: null, text, citations: [], tools: used,
        memo: key && used.length === 0 ? key : null, reused: earlier?.answer ?? null,
        author: message.authorId, channel: message.channelId, created: this.now(),
      }), []);
      clock.lap('record');
      return { text, decision: 'declined', citations: [], timings: clock.laps };
    }
    // A tool's result is measured, not established: an answer that used one is open at most.
    if (used.some((u) => u.result)) level = await this.kernel.level(level, 'open');
    // List only the sources the answer cites, keeping their numbers so inline references still match.
    // An answer that cites none lists them all: the reader still sees what it was given.
    const cited = new Set([...body.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]) - 1));
    const listed = ordered.map((c, i) => ({ c, i })).filter(({ i }) => cited.size === 0 || cited.has(i));
    // Discord's subtext (-#) keeps the evidence visible without competing with the answer.
    const sources = listed.map(({ c, i }) => `-# [${i + 1}] <${c.url}> · ${c.source} · ${c.level} · ${c.label.slice(0, 15)}`).join('\n');
    const notice = grounded === 'answer with notice' ? '\n\n*Low confidence: the sources only partly match the question.*' : '';
    const decided = decision?.answer
      ? `\n-# Decision: ${decision.app} → ${decision.answer} · proved in ${community.pin.commit.slice(0, 7)} of UOR-Foundation/community · holo ${community.pin.holo.slice(0, 15)} · inputs are Q's reading`
      : '';
    const toolLines = used.map((u) => (u.result ? `\n-# Tool: ${u.server}/${u.tool} · ${u.result.slice(0, 15)}` : `\n-# Tool refused: ${u.server}/${u.tool}`)).join('');
    const reusedLine = earlier ? `\n-# Answered once before for this exact question and evidence · ${earlier.answer.slice(0, 15)}` : '';
    const text = `${body}${notice}\n\n-# Claim level: ${level}${decided}${toolLines}${reusedLine}\n${sources}`;

    await this.#said(namespace, turn, turnLabel, answer({
      context: turnLabel, outcome: grounded, level, text: body, citations: ordered.map((c) => c.label), tools: used,
      // An answer that called a tool is never reused: a tool's result can change between calls.
      memo: key && used.length === 0 ? key : null, reused: earlier?.answer ?? null,
      author: message.authorId, channel: message.channelId, created: this.now(),
    }), [...ordered.map((c) => c.label), ...used.flatMap((u) => (u.result ? [u.result] : []))]);
    clock.lap('record');
    return { text, decision: grounded, citations: ordered, timings: clock.laps };
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
    this.actions.emit(event(turn, said));
    return label;
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

  async #askCommunity(question: string, ordered: Citation[], community: Decider): Promise<DecisionAsked | null> {
    const named = new Set(this.#candidates(ordered, community));
    if (!named.size) return null;
    const apps = [...named].map((name) => community.apps.get(name)!);
    const catalog = apps.map((app) => `${app.name}: ${app.purpose}\n${app.fields.map((f) => `  ${describe(f)}`).join('\n')}`).join('\n\n');
    const reply = await this.llm.complete(ROUTER, `Apps:\n\n${catalog}\n\nQuestion: ${question}`);
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
