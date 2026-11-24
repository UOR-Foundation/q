// The only door to the kernel. Every decision the host needs is asked here and
// obeyed; this file encodes facts into the eight-byte request of the README and
// decides nothing itself.
import { readFile } from 'node:fs/promises';
import { kappa, load } from 'prism-code';
import { MODEL, Q } from './client/q.js';

export const KIND = { text: 0, forum: 1, voice: 2, dm: 3 } as const;
export const VISIBILITY = { everyone: 0, restricted: 1 } as const;
export const LABEL = { public: 0, unlabeled: 1, excluded: 2 } as const;
export const INSTALL = { admin: 0, other: 1 } as const;
export const INTENT = { granted: 0, missing: 1 } as const;
export const TRIGGER = { none: 0, mention: 1, replyToAgent: 2, slash: 3 } as const;
// Who a message is from and to: a person talking in the channel, a bot, or a person asking the agent.
export const ORIGIN = { conversation: 0, bot: 1, request: 2 } as const;
export const COMMAND = { ask: 0, search: 1, status: 2, reindex: 3, 'forget-channel': 4, 'forget-me': 5 } as const;
export const ROLE = { member: 0, admin: 1 } as const;
export const BAND = { low: 0, medium: 1, high: 2 } as const;
export const LEVEL = { build: 0, 'some-true': 1, open: 2 } as const;
export const SOURCE = { community: 0, website: 1, github: 2, discord: 3 } as const;
export const CLASS = { publicSource: 0, discord: 1 } as const;
export const ACCESS = { blacklist: 0, whitelist: 1 } as const;
export const STAGE = { incoming: 0, outgoing: 1 } as const;
export const SCOPE = { both: 0, incoming: 1, outgoing: 2 } as const;
export const FILTER = { pass: 0, warn: 1, masked: 2, block: 3 } as const;
/** A reply's size against Discord's 2,000-character message: one message, up to five, or more. */
export const SIZE = { one: 0, few: 1, many: 2 } as const;
export const STRATEGY = { split: 0, file: 1 } as const;
/** Where a question came from: a Discord channel, or a client of the agent's own MCP server. */
export const SURFACE = { discord: 0, mcp: 1 } as const;

export type Level = keyof typeof LEVEL;
export type SourceName = keyof typeof SOURCE;
export type CommandName = keyof typeof COMMAND;
export type Origin = keyof typeof ORIGIN;

export interface ChannelFacts {
  kind: keyof typeof KIND;
  visibility: keyof typeof VISIBILITY;
  label: keyof typeof LABEL;
  install: keyof typeof INSTALL;
  intent: keyof typeof INTENT;
}

// A count is one byte in the request. Limits are validated to fit (config.ts),
// so a count past 255 is still past its limit after this.
const byte = (n: number) => Math.max(0, Math.min(255, Math.trunc(n)));
const flag = (b: boolean) => (b ? 1 : 0);

export class Kernel {
  readonly model = MODEL.blake3;
  /** The holo's BLAKE3 kappa label, over its exact bytes: the kernel every record names. */
  readonly holo: string;
  /** The commit whose signed build is this holo, once its provenance is verified; null when the check is off. */
  commit: string | null = null;
  #client: Q;

  private constructor(client: Q, holo: string) {
    this.#client = client;
    this.holo = holo;
  }

  /** Open the holo. `load` verifies its digests; a holo whose own acceptance vectors do not all replay is refused. */
  static async open(path: string): Promise<Kernel> {
    const bytes = new Uint8Array(await readFile(path));
    const app = await load(bytes);
    if (!app.identities.verified) throw new Error(`kernel refused: ${path} failed identity verification`);
    const result = await app.acceptance();
    if (result.passed !== result.total || result.total === 0) {
      throw new Error(`kernel refused: ${result.passed} of ${result.total} acceptance vectors replayed`);
    }
    return new Kernel(new Q((request) => app.dispatch(request)), kappa(bytes));
  }

  async #ask<T extends string>(decision: number, ...facts: number[]): Promise<T> {
    const request = new Uint8Array(8);
    request[0] = decision;
    facts.forEach((fact, i) => (request[i + 1] = fact));
    const answer = new TextDecoder().decode(await this.#client.invoke(request));
    if (answer === 'invalid request') throw new Error(`kernel: invalid request ${[...request].join(',')}`);
    return answer as T;
  }

  #channel(c: ChannelFacts): number[] {
    return [KIND[c.kind], VISIBILITY[c.visibility], LABEL[c.label], INSTALL[c.install], INTENT[c.intent]];
  }

  read(channel: ChannelFacts) {
    return this.#ask<'permit' | 'deny' | 'not-applicable' | 'indeterminate'>(1, ...this.#channel(channel));
  }
  index(channel: ChannelFacts, origin: Origin, authorOptedOut: boolean) {
    return this.#ask<'index' | 'skip'>(2, ...this.#channel(channel), ORIGIN[origin], flag(authorOptedOut));
  }
  reply(channel: ChannelFacts, trigger: keyof typeof TRIGGER) {
    return this.#ask<'reply' | 'silent'>(3, KIND[channel.kind], VISIBILITY[channel.visibility], TRIGGER[trigger]);
  }
  command(command: CommandName, role: keyof typeof ROLE) {
    return this.#ask<'allowed' | 'not authorized'>(4, COMMAND[command], ROLE[role]);
  }
  rate(userCount: number, userLimit: number, channelCount: number, channelLimit: number) {
    return this.#ask<'allowed' | 'rate limited'>(5, byte(userCount), byte(userLimit), byte(channelCount), byte(channelLimit));
  }
  ground(band: keyof typeof BAND, citations: number) {
    return this.#ask<'answer' | 'answer with notice' | 'not grounded'>(6, BAND[band], byte(citations));
  }
  level(left: Level, right: Level) {
    return this.#ask<Level>(7, LEVEL[left], LEVEL[right]);
  }
  prefer(left: SourceName, right: SourceName) {
    return this.#ask<SourceName>(8, SOURCE[left], SOURCE[right]);
  }
  retain(itemClass: keyof typeof CLASS, forget: boolean, ageDays: number, limitDays: number) {
    return this.#ask<'delete' | 'keep'>(9, CLASS[itemClass], flag(forget), byte(ageDays), byte(limitDays));
  }
  cite(labelled: boolean, verified: boolean, revoked: boolean) {
    return this.#ask<'cite' | 'drop'>(10, flag(labelled), flag(verified), flag(revoked));
  }
  namespace(source: SourceName) {
    return this.#ask<'public' | 'private'>(11, SOURCE[source]);
  }
  /** LangBot's access control: whether a session on the list continues, under a blacklist or a whitelist. */
  access(mode: keyof typeof ACCESS, listed: boolean) {
    return this.#ask<'continue' | 'ignore'>(12, ACCESS[mode], flag(listed));
  }
  /** LangBot's content filter: what a filter's result means at this stage, given the filter's scope. */
  filter(stage: keyof typeof STAGE, scope: keyof typeof SCOPE, level: keyof typeof FILTER) {
    return this.#ask<'continue' | 'masked' | 'interrupt'>(13, STAGE[stage], SCOPE[scope], FILTER[level]);
  }
  /** LangBot's long-text handling, for Discord's message limit: how a reply of this size is delivered. */
  length(size: keyof typeof SIZE, strategy: keyof typeof STRATEGY) {
    return this.#ask<'send' | 'split' | 'file'>(14, SIZE[size], STRATEGY[strategy]);
  }
  /** Whether one MCP tool call may run: its server's place on the allowlist, whether it writes, and who asked. */
  tool(allowlisted: boolean, writes: boolean, role: keyof typeof ROLE) {
    return this.#ask<'call' | 'refuse'>(15, flag(!allowlisted), flag(writes), ROLE[role]);
  }
  /** LangBot's conversation history: whether an earlier turn may be context for this question. */
  history(sameAuthor: boolean, sameChannel: boolean, recent: boolean) {
    return this.#ask<'use' | 'skip'>(16, flag(!sameAuthor), flag(!sameChannel), flag(!recent));
  }
  /** Whether an item may be served on this surface: Discord, or the agent's own MCP server. */
  expose(namespace: 'public' | 'private', surface: keyof typeof SURFACE) {
    return this.#ask<'serve' | 'withhold'>(17, namespace === 'public' ? 0 : 1, SURFACE[surface]);
  }
  /** A reaction: does it change the member role? Only a human's confirmation on the rules message does. */
  membership(onRules: boolean, human: boolean, added: boolean) {
    return this.#ask<'grant' | 'revoke' | 'none'>(18, flag(!onRules), flag(!human), flag(!added));
  }
  /** A chaos experiment: may it run? Only when the community approved its exact label, never on live traffic. */
  experiment(approved: boolean, scope: 'shadow' | 'test' | 'live', abort: boolean) {
    return this.#ask<'run' | 'hold' | 'abort'>(19, flag(!approved), { shadow: 0, test: 1, live: 2 }[scope], flag(abort));
  }
  /** Is the measured output in its steady state, within the hypothesis's bounds and with no invariant broken? */
  steady(errorPct: number, maxErrorPct: number, p95Seconds: number, maxP95Seconds: number, breaches: number) {
    const pct = (n: number) => Math.min(100, Math.max(0, Math.round(n)));
    return this.#ask<'steady' | 'disturbed'>(20, pct(errorPct), pct(maxErrorPct), byte(Math.ceil(p95Seconds)), byte(maxP95Seconds), byte(breaches));
  }
}
