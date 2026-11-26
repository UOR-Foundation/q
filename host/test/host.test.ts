// Host tests. The kernel is the real holo; the store, the embedder and the
// language model are in-process fakes, so nothing here reaches the network.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { before, test } from 'node:test';
import { isLabel, labelOf, matches } from '../src/address.ts';
import { channelLabels, readPolicyDrift, type Decider, type DecisionApp } from '../src/community.ts';
import { COMMAND, Kernel, type ChannelFacts } from '../src/kernel.ts';
import { capabilityReport, capabilityDetail, DISCORD_COMMANDS, DISCORD_EVENTS, WEB_PUBLIC_ROUTES, isCapabilityQuestion, summarizeCapabilities } from '../src/capabilities.ts';
import { MCP_PUBLIC_TOOLS } from '../src/mcp-server.ts';
import { chunks, ingest, type Source } from '../src/knowledge.ts';
import { Memory, type Observed } from '../src/memory.ts';
import { Pipeline, type Incoming, type Progress, type Published, type Settings } from '../src/pipeline.ts';
import { runFocus } from '../src/focus-entry.ts';
import { possibleFocusQuestion } from '../src/focus-answer.ts';
import { STRATEGY_ROUTER } from '../src/focus-strategy.ts';
import { ANSWER_SCHEMA, CONTEXT_SCHEMA, questionKey, type CloudEvent } from '../src/records.ts';
import { Gate, OpenAiCompatibleLlm, retrying, visibleSoFar, withoutReasoning, type Embedder, type Llm, type RunTool, type ToolCall, type ToolSpec } from '../src/providers.ts';
import { AFTER_LIMIT, QUESTION_LIMIT, webServer, type WebOptions } from '../src/adapter/web.ts';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Tools } from '../src/tools.ts';
import { payloads } from '../src/adapter/adapter.ts';
import { Aggregator } from '../src/aggregator.ts';
import { deliver, withoutMention } from '../src/adapter/discord.ts';
import { mcpServer } from '../src/mcp-server.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { SearchIndex } from '../src/search.ts';
import { faulty, loadExperiments, runExperiment, ShadowStore, shadowIndex, strikes, type Experiment, type ExperimentEvent } from '../src/chaos.ts';
import { GENE_BOUNDS, Loop, mutate, type Genes } from '../src/improve.ts';
import { verifyReview } from '../src/self.ts';
import { promptOf, STYLES, systemFor } from '../src/pipeline.ts';
import { areaOf } from '../src/titles.ts';
import { titleOf } from '../src/titles.ts';
import { candidate, Tracker } from '../src/tracker.ts';
import { checkSpec, decide as decideApp, generate, type AppSpec } from '../src/appgen.ts';
import { designSpec, usage } from '../src/apps.ts';
import type { Outgoing } from '../src/pipeline.ts';
import { FileStore, isRevoked, MemoryStore } from '../src/store.ts';

const HOLO = new URL('../../app/.prism/build/q.holo', import.meta.url);

/** Words hashed into 64 buckets: texts sharing words are near, and the same text always gives the same vector. */
class WordEmbedder implements Embedder {
  readonly model = 'test-words';
  async embed(texts: string[]) {
    return texts.map((text) => {
      const vector = new Array(64).fill(0);
      for (const word of text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []) {
        let h = 0;
        for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) % 64;
        vector[h] += 1;
      }
      return vector;
    });
  }
}
class CountingLlm implements Llm {
  readonly model = 'test-model';
  calls = 0;
  /** When set, every answer is this text instead. */
  answer?: string;
  /** The tool calls a tool-using model asks for, in order. */
  wants: ToolCall[] = [];
  results: string[] = [];
  async complete(system: string, user: string, onText?: (delta: string) => void) {
    // The decision reader: it gives the case only when the question states it.
    if (system.startsWith('You read a question for the inputs')) {
      const question = user.slice(user.lastIndexOf('Question:'));
      // Like a real model: the naming app only for a question about naming.
      if (!/naming/.test(question)) return JSON.stringify({ app: null });
      return JSON.stringify({ app: 'uor-test-naming', inputs: /lowercase/.test(question) ? { case: 'lowercase' } : {} });
    }
    this.calls++;
    const text = this.answer ?? `${user.includes('\n\nDecision:') ? 'Decided answer' : 'Answer'} drawn from ${(user.match(/^\[\d+\]/gm) ?? []).length} sources [1].`;
    // A streaming model gives its words a few characters at a time.
    if (onText) for (let at = 0; at < text.length; at += 7) onText(text.slice(at, at + 7));
    return text;
  }
  async completeWithTools(system: string, user: string, _tools: ToolSpec[], run: RunTool) {
    for (const call of this.wants) this.results.push(await run(call));
    return this.complete(system, user);
  }
}

/**
 * A community with two apps: uor-discord-read, answered by Q's own kernel so the two agree unless a test plants
 * a difference, and a one-field naming rule.
 */
class FakeCommunity implements Decider {
  readonly pin = { holo: labelOf({ type: 'holo', name: 'community' }), sha256: 'sha256:0', commit: 'a'.repeat(40), signer: 'test', signedAt: '2026-11-24T00:00:00.000Z' };
  readonly apps = new Map<string, DecisionApp>([
    ['uor-discord-read', { name: 'uor-discord-read', title: 'Discord read', purpose: 'read', fields: [] }],
    ['uor-test-naming', { name: 'uor-test-naming', title: 'Repository naming', purpose: 'Decide whether a repository name follows the naming rule.', fields: [{ name: 'case', kind: 'choice', values: ['lowercase', 'other'], means: 'whether the name is all lowercase' }] }],
  ]);
  flip?: string;
  async decide(app: string, values: string[]) {
    if (!this.apps.has(app)) throw new Error(`no community decision named ${app}`);
    if (app === 'uor-test-naming') return values[0] === 'lowercase' ? 'conformant' : 'nonconforming';
    const [kind, visibility, label, install, intent] = values as [never, never, never, never, never];
    const answer = await kernel.read({ kind, visibility, label, install, intent });
    return values.join(' ') === this.flip ? (answer === 'permit' ? 'deny' : 'permit') : answer;
  }
}

const fixture = (name: Source['name'], level: Source['level'], documents: { url: string; text: string }[]): Source => ({
  name,
  level,
  async *documents() { yield* documents; },
});
const community = fixture('community', 'some-true', [
  { url: 'https://example.test/community/discord-read', text: 'The Discord read policy permits the collector to read a channel only when it is public, labeled, and installed by an admin.' },
  { url: 'https://github.com/UOR-Foundation/community/blob/aaaa/apps/uor-test-naming.prompt.json', text: 'Repository naming rule: decide whether a UOR repository name is conformant. Repository names must be lowercase.' },
]);
const website = fixture('website', 'some-true', [
  { url: 'https://example.test/site/prism', text: 'Prism applications are self-verifying archives built from a LexLean model and proved by the Lean kernel.' },
]);

const open: ChannelFacts = { kind: 'text', visibility: 'everyone', label: 'unlabeled', install: 'admin', intent: 'granted' };
const settings: Settings = {
  userLimit: 3, channelLimit: 20, windowMs: 60_000, mediumSimilarity: 0.35, highSimilarity: 0.5, retrieve: 4, style: 0,
  access: { mode: 'blacklist', list: new Set() }, filter: { scope: 'both', terms: [] }, longText: 'split', concurrency: 4, historyMinutes: 30,
};
const labeled: ChannelFacts = { ...open, label: 'public' };
const said = (text: string, more: Partial<Observed> = {}): Observed => ({ channel: labeled, channelId: 'c1', authorId: 'u1', origin: 'conversation', url: `https://discord.test/c1/${text.length}`, createdMs: Date.parse('2026-11-20T00:00:00Z'), text, ...more });
const ask = (text: string, more: Partial<Incoming> = {}): Incoming => ({ channel: open, channelId: 'c1', authorId: 'u1', role: 'member', trigger: 'mention', text, ...more });

let kernel: Kernel;
before(async () => { kernel = await Kernel.open(HOLO.pathname.replace(/^\/([A-Za-z]:)/, '$1')); });

async function world(over: Partial<Settings> = {}, tools?: Tools) {
  const store = new MemoryStore();
  const index = new SearchIndex();
  const embedder = new WordEmbedder();
  const llm = new CountingLlm();
  await ingest(community, kernel, store, index, embedder);
  await ingest(website, kernel, store, index, embedder);
  const clock = { now: Date.parse('2026-11-23T00:00:00Z') };
  const memory = new Memory(kernel, store, index, embedder, 30, () => clock.now);
  const reindexed = { calls: 0 };
  const decider = new FakeCommunity();
  const events: CloudEvent[] = [];
  const actions = { memory, reindex: async () => { reindexed.calls++; return 'reindexed'; }, community: () => decider, emit: (e: CloudEvent) => events.push(e), tools: () => tools };
  return { store, index, embedder, llm, memory, clock, reindexed, decider, events, pipeline: new Pipeline(kernel, store, index, embedder, llm, { ...settings, ...over }, actions, () => clock.now) };
}

test('the kernel opens only after its own vectors replay, and answers', async () => {
  assert.match(kernel.model, /^[0-9a-f]{64}$/);
  assert.equal(await kernel.namespace('discord'), 'private');
  assert.equal(await kernel.read({ ...open, label: 'public' }), 'permit');
  assert.equal(await kernel.read(open), 'not-applicable');
});

test('a label is a blake3 kappa label, independent of member order, and a changed item no longer matches', () => {
  const label = labelOf({ type: 'chunk', text: 'a', position: 1 });
  assert.ok(isLabel(label));
  assert.equal(label, labelOf({ position: 1, text: 'a', type: 'chunk' }));
  assert.ok(matches({ type: 'chunk', text: 'a', position: 1 }, label));
  assert.ok(!matches({ type: 'chunk', text: 'b', position: 1 }, label));
});

test('chunks keep every paragraph and respect the size', () => {
  const parts = chunks(['one', 'two', 'x'.repeat(50)].join('\n\n'), 20);
  assert.deepEqual(parts.slice(0, 1), ['one\n\ntwo']);
  assert.ok(parts.every((part) => part.length <= 20));
  assert.equal(parts.join('').replace(/\s/g, '').length, 56);
});

test('ingesting the same source twice adds nothing, and public sources go to the public namespace', async () => {
  const { store, index, embedder } = await world();
  const count = index.count();
  const again = await ingest(website, kernel, store, index, embedder);
  assert.equal(again.added, 0);
  assert.equal(index.count(), count);
  assert.equal((await store.labels('private')).length, 0);
  assert.ok((await store.labels('public')).length >= 4);
});

test('the index rebuilt from the store finds the same items', async () => {
  const { store, index, embedder } = await world();
  const question = 'What is a Prism application?';
  const [vector] = await embedder.embed([question]);
  const before = index.search(question, vector, 4).map((hit) => hit.label);
  const rebuilt = new SearchIndex();
  await rebuilt.rebuild(store, embedder);
  assert.deepEqual(rebuilt.search(question, vector, 4).map((hit) => hit.label), before);
});

test('a grounded question is answered with citations, a claim level and a stored answer', async () => {
  const { pipeline, store, llm } = await world();
  const reply = await pipeline.handle(ask('How are Prism applications built from a LexLean model?'));
  assert.ok(reply);
  assert.match(reply.decision, /^answer/);
  assert.ok(reply.citations.length >= 1);
  assert.ok(reply.citations.every((c) => isLabel(c.label)));
  assert.match(reply.text, /Claim level: some-true/);
  // The answer cites only [1], so only [1] is listed, under its own number; the rest stay evidence.
  assert.ok(reply.text.split('\n').includes('-# [1] [example.test › community/discord-read](<https://example.test/community/discord-read>)'));
  assert.doesNotMatch(reply.text, /https:\/\/example\.test\/site\/prism/);
  assert.ok(reply.citations.some((c) => c.url === 'https://example.test/site/prism'));
  assert.equal(llm.calls, 1);
  const items = await Promise.all((await store.labels('private')).map((label) => store.get('private', label)));
  assert.deepEqual(items.map((item) => item?.type).sort(), ['answer', 'context']);
  assert.equal((items.find((item) => item?.type === 'context')?.kernel as { model: string }).model, kernel.model);
  assert.equal(store.edges.private.filter((e) => e.relation === 'evidence-provenance').length, reply.citations.length);
});

test('community is cited before the website when both are retrieved', async () => {
  const { pipeline } = await world();
  const reply = await pipeline.handle(ask('Discord read policy channel public labeled admin Prism applications LexLean model', { command: 'search', trigger: 'slash' }));
  assert.ok(reply && reply.citations.length >= 2);
  assert.deepEqual([...new Set(reply.citations.map((c) => c.source))], ['community', 'website']);
});

test('a question nothing answers is refused, and the language model is never called', async () => {
  const { pipeline, llm } = await world();
  const reply = await pipeline.handle(ask('zebra quantum marmalade'));
  assert.equal(reply?.decision, 'not grounded');
  assert.match(reply!.text, /I don't know/);
  assert.equal(llm.calls, 0);
});

test('an item altered in the store is not cited', async () => {
  const { pipeline, store, llm } = await world();
  for (const [label, bytes] of store.items.public) store.items.public.set(label, bytes.replace('Prism', 'Prizm').replace('Discord', 'Discorb'));
  const reply = await pipeline.handle(ask('How are Prism applications built from a LexLean model?'));
  assert.equal(reply?.decision, 'not grounded');
  assert.equal(llm.calls, 0);
});

test('a revoked item is not cited', async () => {
  const { pipeline, store } = await world();
  for (const label of await store.labels('public')) await store.link('public', { source: label, target: label, relation: 'revocation' });
  const reply = await pipeline.handle(ask('How are Prism applications built from a LexLean model?'));
  assert.equal(reply?.decision, 'not grounded');
});

test('no reply in a direct message, a restricted channel, or without a trigger', async () => {
  const { pipeline } = await world();
  assert.equal(await pipeline.handle(ask('Prism?', { channel: { ...open, kind: 'dm' } })), undefined);
  assert.equal(await pipeline.handle(ask('Prism?', { channel: { ...open, visibility: 'restricted' } })), undefined);
  assert.equal(await pipeline.handle(ask('Prism?', { trigger: 'none' })), undefined);
});

test('an admin command from a member is refused, and from an admin is allowed', async () => {
  const { pipeline } = await world();
  const refused = await pipeline.handle(ask('', { command: 'reindex', trigger: 'slash' }));
  assert.equal(refused?.decision, 'not authorized');
  const allowed = await pipeline.handle(ask('', { command: 'reindex', trigger: 'slash', role: 'admin' }));
  assert.equal(allowed?.decision, 'allowed');
  assert.equal(allowed?.text, 'reindexed');
});

test('a user past the limit is rate limited', async () => {
  const { pipeline } = await world();
  for (let i = 0; i < settings.userLimit; i++) assert.notEqual((await pipeline.handle(ask('', { command: 'status', trigger: 'slash' })))?.decision, 'rate limited');
  assert.equal((await pipeline.handle(ask('', { command: 'status', trigger: 'slash' })))?.decision, 'rate limited');
  assert.equal((await pipeline.handle(ask('', { command: 'status', trigger: 'slash', authorId: 'u2' })))?.decision, 'allowed');
});

test('a message is indexed only in a labeled public channel, from a human who has not opted out, into the private namespace', async () => {
  const { memory, store, index } = await world();
  const count = index.count();
  const publicItems = store.items.public.size;
  assert.equal(await memory.observe(said('Hologram addresses are derived with BLAKE3', { channel: open })), 'skip');
  assert.equal(await memory.observe(said('Hologram addresses are derived with BLAKE3', { channel: { ...labeled, kind: 'dm' } })), 'skip');
  assert.equal(await memory.observe(said('Hologram addresses are derived with BLAKE3', { origin: 'bot' })), 'skip');
  assert.equal(await memory.observe(said('@Q what will the price of Bitcoin be next year?', { origin: 'request' })), 'skip');
  assert.equal(index.count(), count);
  assert.equal(await memory.observe(said('Hologram addresses are derived with BLAKE3')), 'index');
  assert.equal(index.count(), count + 1);
  assert.equal((await store.labels('private')).length, 1);
  assert.equal(store.items.public.size, publicItems);
});

test('a Discord message is cited as open, after the more trusted sources, and makes the answer open', async () => {
  const { memory, pipeline } = await world();
  await memory.observe(said('Prism applications are built from a LexLean model, someone said in chat'));
  const reply = await pipeline.handle(ask('How are Prism applications built from a LexLean model?'));
  assert.ok(reply);
  assert.equal(reply.citations.at(-1)?.source, 'discord');
  assert.equal(reply.citations.at(-1)?.level, 'open');
  assert.match(reply.text, /Claim level: open/);
});

test('forget-me deletes the messages and answers of the author, revokes them, and stops indexing the author', async () => {
  const { memory, pipeline, store, index } = await world();
  await memory.observe(said('Hologram addresses are derived with BLAKE3'));
  await memory.observe(said('A message from someone else about BLAKE3', { authorId: 'u2' }));
  await pipeline.handle(ask('How are Prism applications built from a LexLean model?'));
  const before = index.count();
  const reply = await pipeline.handle(ask('', { command: 'forget-me', trigger: 'slash' }));
  // The message, and the question's two records: its context and its answer.
  assert.match(reply!.text, /Forgot 3 items/);
  assert.equal(index.count(), before - 1);
  const kept = await Promise.all((await store.labels('private')).map((label) => store.get('private', label)));
  assert.ok(kept.every((item) => item?.author !== 'u1' || item?.type === 'opt-out'));
  assert.equal(kept.filter((item) => item?.type === 'revocation').length, 3);
  assert.equal(store.edges.private.filter((edge) => edge.relation === 'revocation').length, 3);
  assert.equal(await memory.observe(said('Another message after forgetting')), 'skip');
  assert.equal(await memory.observe(said('Still indexed', { authorId: 'u2' })), 'index');
});

test('forget-channel needs the admin role and removes only that channel', async () => {
  const { memory, pipeline, index } = await world();
  await memory.observe(said('Message in channel one about BLAKE3'));
  await memory.observe(said('Message in channel two about BLAKE3 too', { channelId: 'c2' }));
  const count = index.count();
  assert.equal((await pipeline.handle(ask('', { command: 'forget-channel', trigger: 'slash' })))?.decision, 'not authorized');
  assert.equal(index.count(), count);
  const reply = await pipeline.handle(ask('', { command: 'forget-channel', trigger: 'slash', role: 'admin' }));
  assert.match(reply!.text, /Forgot 1 items/);
  assert.equal(index.count(), count - 1);
});

test('a deleted or edited message is withdrawn: by its recomputed label when its text is known, by its link when not', async () => {
  const { memory, index, store } = await world();
  const first = said('First draft about BLAKE3 labels', { url: 'https://discord.test/c1/m1' });
  const second = said('Another message about Prism holos', { url: 'https://discord.test/c1/m2' });
  await memory.observe(first);
  await memory.observe(second);
  const count = index.count();
  // An edit: the old text goes, the new text is indexed in its place.
  assert.equal(await memory.withdraw(first.url, first), 1);
  await memory.observe({ ...first, text: 'Final text about BLAKE3 labels' });
  assert.equal(index.count(), count);
  const texts = (await Promise.all((await store.labels('private')).map((l) => store.get('private', l)))).filter((i) => i?.type === 'chunk').map((i) => i!.text);
  assert.ok(texts.includes('Final text about BLAKE3 labels') && !texts.includes('First draft about BLAKE3 labels'));
  // A deletion Q has no copy of: found by its link, and revoked.
  assert.equal(await memory.withdraw(second.url), 1);
  assert.equal(index.count(), count - 1);
  assert.ok(store.edges.private.some((e) => e.relation === 'revocation'));
  // A message never indexed withdraws nothing.
  assert.equal(await memory.withdraw('https://discord.test/c1/none', said('never seen', { url: 'https://discord.test/c1/none' })), 0);
});

test('the retention sweep deletes what is past its limit and keeps what is at it', async () => {
  const { memory, clock, index } = await world();
  const day = 86_400_000;
  // Indexed while young, then aged: a day older than the limit goes, exactly at it stays.
  await memory.observe(said('a message one day old', { createdMs: clock.now - day }));
  await memory.observe(said('a message from today', { createdMs: clock.now }));
  const count = index.count();
  clock.now += 30 * day;
  assert.equal(await memory.sweep(), 1);
  assert.equal(index.count(), count - 1);
  assert.equal(await memory.sweep(), 0);
  // Past one byte of days is past any limit.
  clock.now += 400 * day;
  assert.equal(await memory.sweep(), 1);
});

test('a message already past the retention limit is never indexed, so a backfill does not index what the sweep would delete', async () => {
  const { memory, clock } = await world();
  const day = 86_400_000;
  assert.equal(await memory.observe(said('thirty one days old message', { createdMs: clock.now - 31 * day })), 'skip');
  assert.equal(await memory.observe(said('four hundred days old, past one byte', { createdMs: clock.now - 400 * day })), 'skip');
  assert.equal(await memory.observe(said('exactly thirty days old', { createdMs: clock.now - 30 * day })), 'index');
});

test('reasoning a model leaks into its answer is removed', () => {
  assert.equal(withoutReasoning('We need answer user...\n</think>\n\nThe capital of France is Paris.'), 'The capital of France is Paris.');
  assert.equal(withoutReasoning('Plain answer.'), 'Plain answer.');
});

test('Q refuses to run where its read policy and the community policy differ, on any one of the 96 requests', async () => {
  const decider = new FakeCommunity();
  assert.deepEqual(await readPolicyDrift(kernel, decider), []);
  decider.flip = 'text everyone public admin granted';
  const drift = await readPolicyDrift(kernel, decider);
  assert.equal(drift.length, 1);
  assert.match(drift[0], /^text everyone public admin granted: Q permit, community deny$/);
});

test('channel labels come only from the three the read policy knows', () => {
  assert.deepEqual(channelLabels({ default: 'public', channels: { '42': 'excluded' } }), { default: 'public', channels: { '42': 'excluded' } });
  assert.throws(() => channelLabels({ default: 'open', channels: {} }), /unknown channel label open/);
});

test('every turn leaves a context record, an answer record naming it, and an event with no content', async () => {
  const { pipeline, store, events, decider } = await world();
  const question = 'How are Prism applications built from a LexLean model?';
  const reply = await pipeline.handle(ask(question, { authorId: 'author-7' }));
  assert.ok(reply && /^answer/.test(reply.decision));
  const items = await Promise.all((await store.labels('private')).map(async (label) => ({ label, item: (await store.get('private', label))! })));
  const turn = items.find(({ item }) => item.type === 'context')!;
  const said = items.find(({ item }) => item.type === 'answer')!;
  assert.equal(turn.item.schema, CONTEXT_SCHEMA);
  assert.equal(said.item.schema, ANSWER_SCHEMA);
  assert.equal(said.item.context, turn.label);
  assert.equal(labelOf(turn.item), turn.label);
  assert.equal((turn.item.kernel as { holo: string }).holo, kernel.holo);
  assert.deepEqual(turn.item.community, { holo: decider.pin.holo, commit: decider.pin.commit });
  assert.ok(isLabel(kernel.holo));
  const edges = store.edges.private.filter((edge) => edge.source === said.label);
  assert.ok(edges.some((e) => e.relation === 'derived-from' && e.target === turn.label));
  assert.ok(edges.some((e) => e.relation === 'certified-by' && e.target === kernel.holo));
  assert.ok(edges.filter((e) => e.relation === 'evidence-provenance').length >= 1);
  assert.equal(events.length, 1);
  const [e] = events;
  assert.equal(e.specversion, '1.0');
  assert.ok(isLabel(e.id));
  const published = JSON.stringify(e);
  for (const secret of [question, 'author-7', turn.label, said.label]) assert.ok(!published.includes(secret), `the event leaks ${secret}`);
});

test('a refusal is a turn too: both records and an event, outcome not grounded', async () => {
  const { pipeline, store, events } = await world();
  const reply = await pipeline.handle(ask('zzzz qqqq xxxx'));
  assert.match(reply!.text, /I don't know/);
  const types = await Promise.all((await store.labels('private')).map(async (label) => (await store.get('private', label))!.type));
  assert.deepEqual(types.sort(), ['answer', 'context']);
  assert.equal(events[0].data.outcome, 'not grounded');
  assert.equal(events[0].data.citations, 0);
});

test('a question a community app decides is answered by the community holo, and the answer says so', async () => {
  const { pipeline, store, decider } = await world();
  const reply = await pipeline.handle(ask('Is a lowercase repository name conformant under the repository naming rule?'));
  assert.match(reply!.text, /^-# Decision: uor-test-naming → conformant · proved in aaaaaaa of UOR-Foundation\/community/m);
  const items = await Promise.all((await store.labels('private')).map(async (label) => ({ label, item: (await store.get('private', label))! })));
  const turn = items.find(({ item }) => item.type === 'context')!.item;
  assert.deepEqual(turn.decision, { app: 'uor-test-naming', inputs: { case: 'lowercase' }, missing: [], answer: 'conformant' });
  const said = items.find(({ item }) => item.type === 'answer')!;
  assert.ok(store.edges.private.some((e) => e.source === said.label && e.relation === 'certified-by' && e.target === decider.pin.holo));
});

test('an input the question does not state is named, not guessed, and the community holo is not asked', async () => {
  const { pipeline, store } = await world();
  const reply = await pipeline.handle(ask('Is this repository name conformant under the repository naming rule?'));
  assert.doesNotMatch(reply!.text, /-# Decision:/);
  const items = await Promise.all((await store.labels('private')).map(async (label) => (await store.get('private', label))!));
  const turn = items.find((item) => item.type === 'context')!;
  assert.deepEqual(turn.decision, { app: 'uor-test-naming', inputs: {}, missing: ['case'], answer: null });
});

/** The part of JSON Schema 2020-12 the three published schemas use, so the tests hold the code to the documents. */
type Schema = { [k: string]: unknown };
function conforms(value: unknown, schema: Schema, root: Schema, at = '$'): string[] {
  if (typeof schema.$ref === 'string') return conforms(value, (root.$defs as Record<string, Schema>)[schema.$ref.replace('#/$defs/', '')], root, at);
  if (Array.isArray(schema.oneOf)) {
    const passing = (schema.oneOf as Schema[]).filter((s) => conforms(value, s, root, at).length === 0).length;
    return passing === 1 ? [] : [`${at}: matches ${passing} of oneOf`];
  }
  if ('const' in schema && value !== schema.const) return [`${at}: is not ${JSON.stringify(schema.const)}`];
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return [`${at}: ${JSON.stringify(value)} is not in the enum`];
  const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
  const types = schema.type === undefined ? null : ([] as string[]).concat(schema.type as string);
  if (types && !types.includes(kind)) return [`${at}: is ${kind}, not ${types.join(' or ')}`];
  if (typeof schema.pattern === 'string' && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) return [`${at}: does not match ${schema.pattern}`];
  const errors: string[] = [];
  if (kind === 'array' && schema.items) (value as unknown[]).forEach((v, i) => errors.push(...conforms(v, schema.items as Schema, root, `${at}[${i}]`)));
  if (kind === 'object') {
    const object = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    for (const key of (schema.required ?? []) as string[]) if (!(key in object)) errors.push(`${at}.${key}: is missing`);
    for (const [key, v] of Object.entries(object)) {
      if (properties[key]) errors.push(...conforms(v, properties[key], root, `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}.${key}: is not in the schema`);
      else if (typeof schema.additionalProperties === 'object') errors.push(...conforms(v, schema.additionalProperties as Schema, root, `${at}.${key}`));
    }
  }
  return errors;
}
const schema = async (name: string) => JSON.parse(await readFile(new URL(`../../docs/schemas/${name}.schema.json`, import.meta.url), 'utf8')) as Schema;

test('the records and the event of every kind of turn match their published schemas exactly', async () => {
  const [contextSchema, answerSchema, eventSchema] = await Promise.all(['context', 'answer', 'event'].map(schema));
  const { pipeline, store, events } = await world();
  // One author each: the rate limit is three questions a minute.
  await pipeline.handle(ask('How are Prism applications built from a LexLean model?', { authorId: 'a1' }));
  await pipeline.handle(ask('zzzz qqqq xxxx', { authorId: 'a2' }));
  await pipeline.handle(ask('Is a lowercase repository name conformant under the repository naming rule?', { authorId: 'a3' }));
  await pipeline.handle(ask('Is this repository name conformant under the repository naming rule?', { authorId: 'a4' }));
  const items = await Promise.all((await store.labels('private')).map(async (label) => (await store.get('private', label))!));
  const contexts = items.filter((item) => item.type === 'context');
  const answers = items.filter((item) => item.type === 'answer');
  assert.equal(contexts.length, 4);
  assert.equal(answers.length, 4);
  assert.equal(events.length, 4);
  for (const item of contexts) assert.deepEqual(conforms(item, contextSchema, contextSchema), []);
  for (const item of answers) assert.deepEqual(conforms(item, answerSchema, answerSchema), []);
  for (const e of events) assert.deepEqual(conforms(e, eventSchema, eventSchema), []);
  // The validator can fail: a member the schema does not name is refused.
  assert.notDeepEqual(conforms({ ...contexts[0], extra: 1 }, contextSchema, contextSchema), []);
});

test('a source read again at a newer commit supersedes its old chunks, and a rebuild still equals the index', async () => {
  const { store, index, embedder } = await world();
  const at = (commit: string, text: string) => fixture('community', 'some-true', [{ url: `https://github.com/UOR-Foundation/community/blob/${commit}/README.md`, text }]);
  await ingest(at('c1', 'The community model at its first commit'), kernel, store, index, embedder);
  const before = index.count();
  const result = await ingest(at('c2', 'The community model at its second commit'), kernel, store, index, embedder);
  assert.equal(result.added, 1);
  // The first commit's chunk is superseded (that first read already superseded the fixture's two).
  assert.equal(result.superseded, 1);
  assert.equal(index.count(), before);
  const question = 'community model commit';
  const [vector] = await embedder.embed([question]);
  const urls = await Promise.all(index.search(question, vector, 10).map(async (hit) => String((await store.get(hit.namespace, hit.label))?.url)));
  assert.ok(urls.every((url) => !url.includes('/blob/c1/')));
  const rebuilt = new SearchIndex();
  await rebuilt.rebuild(store, embedder);
  assert.equal(rebuilt.count(), index.count());
});

test('access control: a whitelist answers only listed sessions, a blacklist never a listed one', async () => {
  const whitelist = (await world({ access: { mode: 'whitelist', list: new Set(['c1']) } })).pipeline;
  assert.ok(await whitelist.handle(ask('How are Prism applications built?')));
  assert.equal(await whitelist.handle(ask('How are Prism applications built?', { channelId: 'c9' })), undefined);
  const blacklist = (await world({ access: { mode: 'blacklist', list: new Set(['u-banned']) } })).pipeline;
  assert.equal(await blacklist.handle(ask('How are Prism applications built?', { authorId: 'u-banned' })), undefined);
  assert.ok(await blacklist.handle(ask('How are Prism applications built?', { authorId: 'u-fine' })));
});

test('content filter: a filtered term stops an incoming question and is masked in an outgoing answer', async () => {
  const { pipeline, llm, store } = await world({ filter: { scope: 'both', terms: ['forbidden'] } });
  const stopped = await pipeline.handle(ask('Tell me the forbidden thing about Prism applications'));
  assert.equal(stopped?.decision, 'interrupt');
  assert.equal(llm.calls, 0);
  assert.deepEqual(await store.labels('private'), []);
  llm.answer = 'Prism applications are built from a forbidden LexLean model [1].';
  const masked = await pipeline.handle(ask('How are Prism applications built from a LexLean model?'));
  assert.match(masked!.text, /from a \*{9} LexLean model/);
  // Out of scope, the term passes.
  const outgoingOnly = (await world({ filter: { scope: 'outgoing', terms: ['forbidden'] } })).pipeline;
  assert.notEqual((await outgoingOnly.handle(ask('Tell me the forbidden thing about Prism applications')))?.decision, 'interrupt');
});

test('long text: one message is sent, up to five split or filed by setting, and more always filed', async () => {
  const sized = async (length: number, longText: 'split' | 'file') => {
    const { pipeline, llm } = await world({ longText });
    llm.answer = 'x'.repeat(length);
    return (await pipeline.handle(ask('How are Prism applications built from a LexLean model?')))!;
  };
  assert.equal((await sized(100, 'split')).delivery, 'send');
  const split = await sized(4000, 'split');
  assert.equal(split.delivery, 'split');
  assert.ok(payloads(split, 2000).every((p) => p.content.length <= 2000 && !p.file));
  assert.equal((await sized(4000, 'file')).delivery, 'file');
  const many = await sized(20000, 'split');
  assert.equal(many.delivery, 'file');
  const [filed] = payloads(many, 2000);
  assert.equal(filed.file?.name, 'answer.md');
  assert.ok(filed.content.length <= 2000);
});

test('the query pool works on no more questions at once than its limit', async () => {
  const { pipeline, llm } = await world({ concurrency: 1 });
  let running = 0, most = 0;
  const complete = llm.complete.bind(llm);
  // Count the answers being written: one per question, however its decision is read.
  llm.complete = async (system: string, user: string) => {
    if (system.startsWith('You read a question')) return complete(system, user);
    running++; most = Math.max(most, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running--;
    return complete(system, user);
  };
  await Promise.all(['a', 'b', 'c'].map((author) => pipeline.handle(ask('How are Prism applications built from a LexLean model?', { authorId: author }))));
  assert.equal(most, 1);
});

/** An MCP server over the SDK's in-memory transport: one read-only tool, one that writes. */
async function mcp(allow: boolean): Promise<Tools> {
  const server = new Server({ name: 'test', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: 'lookup', description: 'Look a term up', inputSchema: { type: 'object', properties: { term: { type: 'string' } } }, annotations: { readOnlyHint: true } },
      { name: 'publish', description: 'Publish a note', inputSchema: { type: 'object', properties: { note: { type: 'string' } } } },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => ({ content: [{ type: 'text', text: `${request.params.name} ran with ${JSON.stringify(request.params.arguments)}` }] }));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientSide);
  const tools = new Tools();
  await tools.add({ name: 'uor', allow }, client);
  return tools;
}

test('MCP registry publishes only complete unique catalogs and keeps exact registered entries',async()=>{
  const registry=new Tools();
  let calls=0, closes=0;
  const make=(names:string[],fail=false)=>({
    listTools:async()=>{if(fail)throw Error('synthetic discovery error');return {tools:names.map(name=>({name,inputSchema:{type:'object'},annotations:{readOnlyHint:true}}))};},
    callTool:async()=>{calls++;return {content:[{type:'text',text:'synthetic result'}]};},
    close:async()=>{closes++;},
  }) as unknown as Client;
  await registry.add({name:'alpha',allow:true},make(['lookup']));
  const original=registry.find('alpha__lookup')!;
  await assert.rejects(registry.add({name:'alpha',allow:true},make(['other'])));
  await assert.rejects(registry.add({name:'beta',allow:true},make(['same','same'])));
  await assert.rejects(registry.add({name:'gamma',allow:true},make(['unused'],true)));
  assert.deepEqual(registry.list(),[original]);
  await assert.rejects(registry.call({...original},{}));
  assert.equal(calls,0);
  assert.equal(await registry.call(original,{}),'synthetic result');
  assert.equal(calls,1);
  await registry.close();
  assert.equal(closes,1);
  assert.deepEqual(registry.list(),[]);
  await assert.rejects(registry.call(original,{}));
  await assert.rejects(registry.add({name:'after-close'},make(['lookup'])));
  assert.equal(calls,1);
});

test('MCP duplicate server configuration is refused before transport creation',async()=>{
  const {tools,failed}=await Tools.connect([{name:'duplicate'},{name:'duplicate'}],()=>assert.fail('ambiguous server must not connect'));
  assert.equal(failed.length,2);
  assert.deepEqual(tools.list(),[]);
});

test('MCP concurrent catalog registration commits at most one entry set',async()=>{
  const registry=new Tools();
  const client=(name:string)=>({listTools:async()=>({tools:[{name,inputSchema:{type:'object'}}]}),close:async()=>{}}) as unknown as Client;
  const results=await Promise.allSettled([registry.add({name:'same'},client('first')),registry.add({name:'same'},client('second'))]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.filter(r=>r.status==='rejected').length,1);
  assert.equal(registry.list().length,1);
  await registry.close();
});

test('MCP tools: the kernel lets a member read and refuses a member writing, and each result is a labelled record', async () => {
  const tools = await mcp(true);
  assert.deepEqual(tools.list().map((t) => [t.qualified, t.writes, t.allowlisted]), [['uor__lookup', false, true], ['uor__publish', true, true]]);
  const { pipeline, llm, store } = await world({}, tools);
  llm.wants = [{ name: 'uor__lookup', arguments: { term: 'holo' } }, { name: 'uor__publish', arguments: { note: 'hi' } }];
  const reply = await pipeline.handle(ask('How are Prism applications built from a LexLean model?'));
  assert.deepEqual(llm.results, ['lookup ran with {"term":"holo"}', 'Refused: this tool is not allowed here.']);
  assert.match(reply!.text, /^-# Claim level: open$/m);
  assert.match(reply!.text, /^-# Tool: uor\/lookup · blake3:/m);
  assert.match(reply!.text, /^-# Tool refused: uor\/publish$/m);
  const items = await Promise.all((await store.labels('private')).map(async (label) => ({ label, item: (await store.get('private', label))! })));
  const result = items.find(({ item }) => item.type === 'tool-result')!;
  const said = items.find(({ item }) => item.type === 'answer')!.item;
  assert.deepEqual(said.tools, [{ server: 'uor', tool: 'lookup', decision: 'call', result: result.label }, { server: 'uor', tool: 'publish', decision: 'refuse', result: null }]);
  // An admin may write; nobody may use a server that is not allowlisted.
  const admin = await world({}, tools);
  admin.llm.wants = [{ name: 'uor__publish', arguments: { note: 'hi' } }];
  await admin.pipeline.handle(ask('How are Prism applications built from a LexLean model?', { role: 'admin' }));
  assert.deepEqual(admin.llm.results, ['publish ran with {"note":"hi"}']);
  const unlisted = await world({}, await mcp(false));
  unlisted.llm.wants = [{ name: 'uor__lookup', arguments: {} }];
  await unlisted.pipeline.handle(ask('How are Prism applications built from a LexLean model?', { role: 'admin' }));
  assert.deepEqual(unlisted.llm.results, ['Refused: this tool is not allowed here.']);
});

test('compute once: the same question on the same evidence is answered once, and forgetting its author forgets the reuse', async () => {
  const { pipeline, llm, store, events, index, embedder } = await world();
  const first = await pipeline.handle(ask('How are Prism applications built from a LexLean model?', { authorId: 'asker-1' }));
  assert.equal(llm.calls, 1);
  // Case and spacing do not change the question; a different author asks it.
  const again = await pipeline.handle(ask('  how are PRISM applications built   from a LexLean model? ', { authorId: 'asker-2' }));
  assert.equal(llm.calls, 1);
  assert.match(again!.text, /^-# Answered once before for this exact question and evidence · blake3:/m);
  assert.equal(again!.text.split('\n-# ')[0], first!.text.split('\n-# ')[0]);
  const answers = (await Promise.all((await store.labels('private')).map(async (label) => ({ label, item: (await store.get('private', label))! })))).filter(({ item }) => item.type === 'answer');
  const computed = answers.find(({ item }) => item.author === 'asker-1')!;
  const reused = answers.find(({ item }) => item.author === 'asker-2')!;
  assert.ok(isLabel(computed.item.memo));
  assert.equal(reused.item.memo, computed.item.memo);
  assert.equal(reused.item.reused, computed.label);
  assert.ok(store.edges.private.some((e) => e.source === reused.label && e.relation === 'derived-from' && e.target === computed.label));
  assert.deepEqual(events.map((e) => e.data.reused), [false, true]);
  // A rebuilt index recovers the memo from the answer records.
  const rebuilt = new SearchIndex();
  await rebuilt.rebuild(store, embedder);
  assert.equal(rebuilt.memoGet(computed.item.memo as string)?.answer, computed.label);
  // Forgetting the first author deletes the computed answer: the next asking computes it again.
  await pipeline.handle(ask('', { command: 'forget-me', trigger: 'slash', authorId: 'asker-1' }));
  await pipeline.handle(ask('How are Prism applications built from a LexLean model?', { authorId: 'asker-3' }));
  assert.equal(llm.calls, 2);
  assert.ok(index.count() > 0);
});

test('a different question, or different evidence, is a different key and is computed', async () => {
  const { pipeline, llm } = await world();
  await pipeline.handle(ask('How are Prism applications built from a LexLean model?', { authorId: 'a' }));
  await pipeline.handle(ask('How are Prism applications verified by the Lean kernel?', { authorId: 'b' }));
  assert.equal(llm.calls, 2);
});

test('the folder store reads its edge log incrementally, including edges another process appended', async () => {
  const { mkdtemp, appendFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'q-store-'));
  const store = new FileStore(root);
  const a = await store.put('public', { type: 'chunk', text: 'a' });
  const b = await store.put('public', { type: 'chunk', text: 'b' });
  await store.link('public', { source: b, target: a, relation: 'section-of' });
  assert.equal((await store.edgesTo('public', a)).length, 1);
  // Another process appends a revocation; this store sees it on the next call.
  await appendFile(join(root, 'public', 'edges.jsonl'), JSON.stringify({ source: b, target: a, relation: 'revocation' }) + '\n');
  assert.ok(await isRevoked(store, 'public', a));
  assert.deepEqual((await store.edgesTo('public', b)), []);
});

test('a reply split over several Discord messages is delivered whole, in order', async () => {
  const text = Array.from({ length: 60 }, (_, i) => `line ${i} ` + 'x'.repeat(80)).join('\n');
  const parts = payloads({ text, decision: 'allowed', citations: [], delivery: 'split' }, 2000);
  assert.ok(parts.length >= 3);
  const sent: string[] = [];
  const first = await deliver(parts, async (payload) => { sent.push(payload.content); return { id: sent.length }; });
  assert.deepEqual(sent, parts.map((p) => p.content));
  assert.equal(sent.join(''), parts.map((p) => p.content).join(''));
  assert.deepEqual(first, { id: 1 });
  assert.equal(await deliver([], async () => assert.fail('nothing to send')), undefined);
});

test('Q\'s mention is removed in both Discord forms, and nobody else\'s', () => {
  assert.equal(withoutMention('<@123> What are you capable of?', '123'), 'What are you capable of?');
  assert.equal(withoutMention('<@!123> What are you capable of?', '123'), 'What are you capable of?');
  assert.equal(withoutMention('What do <@!123> and <@123> do?', '123'), 'What do  and  do?');
  assert.equal(withoutMention('<@!456> <@456> hello <@123>', '123'), '<@!456> <@456> hello');
  assert.equal(withoutMention('<@1234> hi', '123'), '<@1234> hi');
  assert.equal(withoutMention('<@!123>', '123'), '');
});

test('an empty mention is answered at once, without retrieval or the language model', async () => {
  const { pipeline, llm, store } = await world();
  const reply = await pipeline.handle(ask('   '));
  assert.equal(reply?.decision, 'empty');
  assert.match(reply!.text, /^Ask me a question about the UOR Foundation/);
  assert.equal(llm.calls, 0);
  assert.deepEqual(await store.labels('private'), []);
});

test('when the writer finds no answer in the sources, the reply is a plain refusal with nothing that looks like evidence', async () => {
  const { pipeline, llm, store } = await world();
  llm.answer = 'NO_ANSWER';
  const reply = await pipeline.handle(ask('How are Prism applications built from a LexLean model?'));
  assert.equal(reply?.decision, 'declined');
  assert.equal(reply!.text, "I don't know: the sources I found do not answer that.");
  const said = (await Promise.all((await store.labels('private')).map((l) => store.get('private', l)))).find((i) => i?.type === 'answer')!;
  assert.equal(said.level, null);
  assert.deepEqual(said.citations, []);
});

test('reading a decision runs beside the plain answer: no decision costs no wait, a decision writes the answer again with it', async () => {
  const plain = await world();
  // The naming app is retrieved, but the question is not a naming decision.
  await plain.pipeline.handle(ask('Must a UOR repository name be lowercase?'));
  assert.equal(plain.llm.calls, 1);
  const decided = await world();
  await decided.pipeline.handle(ask('Is a lowercase repository name conformant under the repository naming rule?'));
  // The plain answer written in parallel is set aside; the decision's answer is the one sent.
  assert.equal(decided.llm.calls, 2);
});

test('the model gate lets no more calls run at once than its limit, in order', async () => {
  const gate = new Gate(2);
  let running = 0, most = 0;
  const order: number[] = [];
  await Promise.all([0, 1, 2, 3, 4].map((i) => gate.run(async () => {
    running++; most = Math.max(most, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running--;
    order.push(i);
  })));
  assert.equal(most, 2);
  assert.equal(order.length, 5);
});

test('a busy provider is retried, after its Retry-After or a backoff, and any other failure is not', async () => {
  const slept: number[] = [];
  const sleep = async (ms: number) => { slept.push(ms); };
  const answers = [new Response('busy', { status: 429, headers: { 'retry-after': '3' } }), new Response('busy', { status: 503 }), new Response('{"ok":1}', { status: 200 })];
  const response = await retrying(async () => answers.shift()!, [1000, 2000], sleep);
  assert.equal(response.status, 200);
  assert.deepEqual(slept, [3000, 2000]);
  await assert.rejects(retrying(async () => new Response('bad', { status: 400 }), [1000], sleep), /400/);
  await assert.rejects(retrying(async () => new Response('busy', { status: 429 }), [1], sleep), /429/);
});

test('the aggregator folds a burst from one person in one channel into one batch, and keeps others apart', async () => {
  const aggregator = new Aggregator<string>(20);
  const [a, b, c, other] = await Promise.all([
    aggregator.offer('c1:u1', 'what is'),
    aggregator.offer('c1:u1', 'LexLean'),
    aggregator.offer('c1:u1', 'exactly?'),
    aggregator.offer('c1:u2', 'unrelated'),
  ]);
  // Every message of the burst learns the whole batch; only the last one is answered.
  for (const early of [a, b]) assert.deepEqual(early, { items: ['what is', 'LexLean', 'exactly?'], last: false });
  assert.deepEqual(c, { items: ['what is', 'LexLean', 'exactly?'], last: true });
  assert.deepEqual(other, { items: ['unrelated'], last: true });
  assert.deepEqual(await new Aggregator<string>(0).offer('k', 'now'), { items: ['now'], last: true });
});

test('one session works on one question at a time, in order, while other sessions run beside it', async () => {
  const { pipeline, llm } = await world({ concurrency: 4 });
  const order: string[] = [];
  let running = 0, most = 0;
  const complete = llm.complete.bind(llm);
  llm.complete = async (system: string, user: string) => {
    if (system.startsWith('You read a question')) return complete(system, user);
    running++; most = Math.max(most, running);
    await new Promise((resolve) => setTimeout(resolve, 10));
    order.push(user.slice(user.lastIndexOf('Question:')));
    running--;
    return complete(system, user);
  };
  await Promise.all([
    pipeline.handle(ask('How are Prism applications built from a LexLean model? first', { authorId: 'same' })),
    pipeline.handle(ask('How are Prism applications built from a LexLean model? second', { authorId: 'same' })),
  ]);
  assert.equal(most, 1);
  assert.deepEqual(order.map((q) => q.endsWith('first') ? 1 : 2), [1, 2]);
});

test('a reply to Q builds on the same author\'s recent turns only, and records them; a forgotten turn is gone', async () => {
  const { pipeline, llm, store } = await world();
  const prompts: string[] = [];
  const complete = llm.complete.bind(llm);
  llm.complete = async (system: string, user: string) => { prompts.push(user); return complete(system, user); };
  await pipeline.handle(ask('How are Prism applications built from a LexLean model?', { authorId: 'ana' }));
  await pipeline.handle(ask('What does the Discord read policy permit?', { authorId: 'ben' }));
  prompts.length = 0;
  await pipeline.handle(ask('And are Prism applications built from a LexLean model proved?', { authorId: 'ana', trigger: 'replyToAgent' }));
  const sent = prompts.find((p) => p.includes('Question: And are Prism applications built from a LexLean model proved?'))!;
  assert.match(sent, /^Earlier in this conversation/);
  assert.match(sent, /Question: How are Prism applications built from a LexLean model\?/);
  // Ben's turn is another author's: it is not history, whatever the sources say.
  assert.doesNotMatch(sent.slice(0, sent.indexOf('Sources:')), /What does the Discord read policy permit/);
  const contexts = (await Promise.all((await store.labels('private')).map((l) => store.get('private', l)))).filter((i) => i?.type === 'context');
  const reply = contexts.find((i) => (i!.request as { question: string }).question === 'And are Prism applications built from a LexLean model proved?')!;
  assert.equal((reply.history as string[]).length, 1);
  // Forgetting the author removes the turn: the next reply has no history.
  await pipeline.handle(ask('', { command: 'forget-me', trigger: 'slash', authorId: 'ana' }));
  prompts.length = 0;
  await pipeline.handle(ask('And are Prism applications built from a LexLean model verified?', { authorId: 'ana', trigger: 'replyToAgent' }));
  assert.ok(prompts.every((p) => !p.startsWith('Earlier in this conversation')));
});

test("Q's MCP server serves public knowledge, withholds every Discord item, and answers community decisions", async () => {
  const { pipeline, memory, decider } = await world();
  // A Discord message that would match the query, indexed in the private namespace.
  await memory.observe(said('Prism applications are discussed here on Discord with a secret detail'));
  const server = mcpServer(pipeline, kernel, () => decider);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientSide);
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ['ask', 'community_apps', 'community_decide', 'search', 'status']);
  const found = await client.callTool({ name: 'search', arguments: { query: 'Prism applications self-verifying archives built from a LexLean model' } });
  const found_text = (found.content as { text: string }[])[0].text;
  assert.match(found_text, /example\.test\/site\/prism/);
  assert.doesNotMatch(found_text, /discord\.test|secret detail/);
  // On Discord the same item may be served: the surface decides, not the query.
  const onDiscord = await pipeline.handle(ask('Prism applications discussed on Discord secret detail', { command: 'search', trigger: 'slash', authorId: 'd1' }));
  assert.match(onDiscord!.text, /discord\.test/);
  const status = JSON.parse((await client.callTool({ name: 'status', arguments: {} }) as { content: { text: string }[] }).content[0].text);
  assert.equal(status.kernel.holo, kernel.holo);
  const decided = await client.callTool({ name: 'community_decide', arguments: { app: 'uor-test-naming', inputs: ['lowercase'] } });
  assert.match((decided.content as { text: string }[])[0].text, /^conformant/);
  const refused = await client.callTool({ name: 'community_decide', arguments: { app: 'no-such-app', inputs: [] } });
  assert.equal(refused.isError, true);
});

test('the member role changes only on a human confirming the rules message: grant on confirm, revoke on withdraw', async () => {
  assert.equal(await kernel.membership(true, true, true), 'grant');
  assert.equal(await kernel.membership(true, true, false), 'revoke');
  // A reaction elsewhere, or a bot's, changes nothing.
  for (const [onRules, human, added] of [[false, true, true], [false, true, false], [true, false, true], [true, false, false]] as const) {
    assert.equal(await kernel.membership(onRules, human, added), 'none');
  }
});

// Chaos engineering: a fake model provider on the network, so a fault takes the real path through the gate and the retries.
const chat: typeof fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Prism applications are built from a LexLean model [1].' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
const experimentOf = (fault: Experiment['variable']['fault'], ratePct: number): Experiment => ({
  type: 'experiment', spec: 'uor-q/experiment/1', name: `test-${fault}`, why: 'a test',
  hypothesis: { maxErrorPct: 0, maxP95Seconds: 30 }, variable: { fault, ratePct },
  questions: [{ text: 'How are Prism applications built from a LexLean model?', expect: 'answered' }, { text: '', expect: 'empty' }],
});
async function chaosWorld(approve: boolean, experiment: Experiment, load = 0) {
  const w = await world();
  const label = labelOf(experiment);
  const events: ExperimentEvent[] = [];
  let llmCalls = 0;
  const counted = (base: typeof fetch) => (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => { llmCalls++; return base(input, init); }) as typeof fetch;
  const deps = {
    kernel,
    community: () => ({ pin: w.decider.pin, experiments: new Set(approve ? [label] : []) }),
    shadow: (llm: typeof fetch, _embedder: typeof fetch, concurrency: number) => {
      const shadowStore = new ShadowStore(w.store);
      const quiet = shadowIndex(w.index);
      const model = new OpenAiCompatibleLlm('http://model.test', '', 'test-model', false, 1024, concurrency, counted(llm));
      return new Pipeline(kernel, shadowStore, quiet, w.embedder, model, { ...settings, userLimit: 255, channelLimit: 255, concurrency },
        { memory: new Memory(kernel, shadowStore, quiet, w.embedder, 30), reindex: async () => '', community: () => w.decider, emit: () => {} });
    },
    load: () => load, store: w.store, emit: (e: ExperimentEvent) => events.push(e), now: () => 0, network: chat,
  };
  return { ...w, deps, events, label, llmCalls: () => llmCalls };
}

test('a fault strikes the calls BLAKE3 of the experiment label and the index picks, the same calls every run', () => {
  const struck = Array.from({ length: 1000 }, (_, i) => strikes('blake3:' + 'a'.repeat(64), i, 30));
  assert.deepEqual(struck, Array.from({ length: 1000 }, (_, i) => strikes('blake3:' + 'a'.repeat(64), i, 30)));
  const share = struck.filter(Boolean).length / 10;
  assert.ok(share > 25 && share < 35, `struck ${share}% of calls at 30%`);
  assert.ok(Array.from({ length: 100 }, (_, i) => strikes('x', i, 0)).every((s) => !s));
  assert.ok(Array.from({ length: 100 }, (_, i) => strikes('x', i, 100)).every(Boolean));
});

test('a faulty network fails the way its fault says, and is the real one on calls it does not strike', async () => {
  assert.equal((await faulty(chat, 'llm-busy', 'x', 100)('http://model.test')).status, 429);
  assert.equal((await faulty(chat, 'embedder-down', 'x', 100)('http://model.test')).status, 503);
  await assert.rejects(faulty(chat, 'llm-down', 'x', 100)('http://model.test'), /fetch failed/);
  await assert.rejects((await faulty(chat, 'llm-malformed', 'x', 100)('http://model.test')).json());
  assert.equal((await faulty(chat, 'llm-down', 'x', 0)('http://model.test')).status, 200);
});

test('an experiment the community has not approved by its exact label holds, and nothing is asked', async () => {
  const w = await chaosWorld(false, experimentOf('llm-down', 100));
  const { result } = await runExperiment(w.deps, experimentOf('llm-down', 100));
  assert.equal(result.verdict, 'held');
  assert.equal(w.llmCalls(), 0);
  // One changed byte is a new experiment: approving the old label does not approve it.
  assert.notEqual(labelOf(experimentOf('llm-down', 100)), labelOf(experimentOf('llm-down', 99)));
});

test('an approved experiment yields to a real question: it is aborted before it asks anything', async () => {
  const w = await chaosWorld(true, experimentOf('llm-down', 100), 1);
  const { result } = await runExperiment(w.deps, experimentOf('llm-down', 100));
  assert.equal(result.verdict, 'aborted');
  assert.equal(w.llmCalls(), 0);
});

test('an approved experiment measures a control and an experimental arm: a fault Q withstands is confirmed, one it does not is disproved', async () => {
  const fine = await chaosWorld(true, experimentOf('llm-busy', 0));
  const confirmed = await runExperiment(fine.deps, experimentOf('llm-busy', 0));
  assert.equal(confirmed.result.verdict, 'confirmed');
  assert.equal(confirmed.result.control!.steady, 'steady');
  assert.equal(confirmed.result.experimental!.errorPct, 0);

  const down = await chaosWorld(true, experimentOf('llm-down', 100));
  const disproved = await runExperiment(down.deps, experimentOf('llm-down', 100));
  assert.equal(disproved.result.verdict, 'disproved');
  assert.equal(disproved.result.experimental!.steady, 'disturbed');
  assert.equal(disproved.result.experimental!.outcomes.error, 1);
  // The empty question needs no model, so it still meets its expectation.
  assert.equal(disproved.result.experimental!.outcomes.empty, 1);

  // The result is a labelled record, linked to the experiment and to both holos, and its event carries its label as id.
  const [event] = down.events;
  assert.equal(event.id, disproved.label);
  assert.equal(event.data.experiment, down.label);
  assert.equal(labelOf((await down.store.get('public', disproved.label))!), disproved.label);
  assert.ok(await down.store.has('public', down.label));
  const edges = down.store.edges.public.filter((e) => e.source === disproved.label);
  assert.deepEqual(edges.map((e) => e.relation).sort(), ['certified-by', 'certified-by', 'derived-from']);
  // The shadow wrote nothing to production but the result: no answer, no context, no memo.
  const kinds = (await Promise.all((await down.store.labels('private')).map((l) => down.store.get('private', l)))).map((i) => i?.type);
  assert.ok(!kinds.includes('answer') && !kinds.includes('context'));
});

test('an experiment, its result and its event match their published schemas exactly', async () => {
  const [experimentSchema, resultSchema, eventSchema] = await Promise.all(['experiment', 'experiment-result', 'experiment-event'].map(schema));
  for (const { experiment } of await loadExperiments(new URL('../../experiments', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
    assert.deepEqual(conforms(experiment, experimentSchema, experimentSchema), []);
  }
  for (const approve of [false, true]) {
    const w = await chaosWorld(approve, experimentOf('llm-busy', 0));
    const { label } = await runExperiment(w.deps, experimentOf('llm-busy', 0));
    assert.deepEqual(conforms((await w.store.get('public', label))!, resultSchema, resultSchema), []);
    assert.deepEqual(conforms(w.events[0], eventSchema, eventSchema), []);
  }
});

test('the experiments in experiments/ are well formed, each named by its BLAKE3 label', async () => {
  const all = await loadExperiments(new URL('../../experiments', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  assert.ok(all.length >= 6);
  for (const { label, experiment } of all) assert.equal(label, labelOf(experiment));
});

// The improvement loop.
async function loopWorld(filed: { label: string; supporters: number }[] = []) {
  const w = await world();
  const events: object[] = [];
  const clock = { now: Date.parse('2026-11-24T00:00:00Z') };
  const live = { settings: { ...settings } as Settings };
  const network = (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Prism applications are built from a LexLean model [1].' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  const loop = new Loop({
    kernel, store: w.store, index: w.index, embedder: w.embedder, community: () => w.decider,
    shadow: (s = live.settings) => {
      const shadowStore = new ShadowStore(w.store);
      const quiet = shadowIndex(w.index);
      const model = new OpenAiCompatibleLlm('http://model.test', '', 'test-model', false, 1024, 1, network);
      return new Pipeline(kernel, shadowStore, quiet, w.embedder, model, { ...s, userLimit: 255, channelLimit: 255, concurrency: 1 },
        { memory: new Memory(kernel, shadowStore, quiet, w.embedder, 30), reindex: async () => '', community: () => w.decider, emit: () => {} });
    },
    settings: () => live.settings, adopt: (g: Genes) => { live.settings = { ...live.settings, ...g }; },
    load: () => 0, experiments: () => [], probes: [{ text: 'zzzz qqqq xxxx', expect: 'refused' }],
    optedOut: (member: string) => w.memory.optedOut(member), unlearn: (label: string) => w.memory.unlearn(label),
    emit: (e: object) => events.push(e), now: () => clock.now,
    evaluation: { size: 12, maxErrorPct: 10, maxP95Seconds: 60, minClass: 2, maxRefusedPct: 50, maxWrongPct: 20 },
    requests: { threshold: 2, file: async (r) => { filed.push(r); return `https://github.test/community/issues/${filed.length}`; } },
  });
  w.memory.removed = (label, item) => loop.unlearned(label, item);
  return { ...w, loop, events, clock, live, filed };
}
const cites = [{ label: 'blake3:' + '2'.repeat(64), url: 'u', source: 'website' as const, level: 'some-true' as const, text: 't' }];

test('a refused question is a gap; a member reply to it fills the gap and becomes a test; forgetting the asker forgets both', async () => {
  const w = await loopWorld();
  const answerLabel = await w.store.put('private', { type: 'answer', text: 'x' });
  const refused: Outgoing = { text: "I don't know", decision: 'not grounded', citations: [], delivery: 'send', answer: answerLabel };
  await w.loop.delivered({ questionUrl: 'https://discord.test/c1/q1', sentUrl: 'https://discord.test/c1/r1', question: 'Where do Prism apps keep their ledgers?', channelId: 'c1', authorId: 'asker', reply: refused });
  assert.equal(await w.loop.observed(said('Unrelated chatter about BLAKE3'), 'index'), undefined);
  assert.equal(await w.loop.observed(said('A bot says model ids', { replyTo: 'https://discord.test/c1/q1', origin: 'bot', url: 'https://discord.test/c1/b1' }), 'skip'), 'skip');
  const reply = said('They live in model/ids.toml, with a scenario per ID in features/suites.', { replyTo: 'https://discord.test/c1/q1', authorId: 'helper', url: 'https://discord.test/c1/m2' });
  assert.equal(await w.memory.observe(reply), 'index');
  assert.equal(await w.loop.observed(reply, 'index'), 'fill');
  assert.equal(await w.loop.observed(said('Also see CONFORMANCE.md', { replyTo: 'https://discord.test/c1/q1', authorId: 'other', url: 'https://discord.test/c1/m3' }), 'index'), 'skip');
  const items = (await Promise.all((await w.store.labels('private')).map((l) => w.store.get('private', l)))).filter(Boolean);
  assert.equal(items.filter((i) => i!.type === 'gap-fill').length, 1);
  const testCase = items.find((i) => i!.type === 'test-case')!;
  assert.equal(testCase.question, 'Where do Prism apps keep their ledgers?');
  await w.memory.forget({ author: 'asker' });
  const left = (await Promise.all((await w.store.labels('private')).map((l) => w.store.get('private', l)))).filter(Boolean).map((i) => i!.type);
  assert.ok(!left.includes('gap') && !left.includes('test-case'));
});

test('a member approval makes a grounded answer a test, once; a refusal, a bot or another reaction does not', async () => {
  const w = await loopWorld();
  const answerLabel = await w.store.put('private', { type: 'answer', text: 'x' });
  await w.loop.delivered({ sentUrl: 'https://discord.test/a2', question: 'How are Prism applications built from a LexLean model?', channelId: 'c1', authorId: 'u2', reply: { text: 'a', decision: 'answer', citations: cites, delivery: 'send', answer: answerLabel } });
  await w.loop.delivered({ sentUrl: 'https://discord.test/a3', question: 'Unanswerable?', channelId: 'c1', authorId: 'u3', reply: { text: 'no', decision: 'not grounded', citations: [], delivery: 'send', answer: answerLabel } });
  assert.equal(await w.loop.reacted('https://discord.test/a2', '😂', true, 'm1'), 'skip');
  assert.equal(await w.loop.reacted('https://discord.test/a2', '👍', false, 'bot'), 'drop');
  assert.equal(await w.loop.reacted('https://discord.test/a3', '👍', true, 'm1'), 'skip');
  assert.equal(await w.loop.reacted('https://discord.test/a2', '👍', true, 'm1'), 'admit');
  assert.equal(await w.loop.reacted('https://discord.test/a2', '✅', true, 'm2'), 'admit');
  const items = async () => (await Promise.all((await w.store.labels('private')).map((l) => w.store.get('private', l)))).filter(Boolean);
  const tests = (await items()).filter((i) => i!.type === 'test-case');
  assert.equal(tests.length, 1);
  // The test names everyone it was made from, so forgetting any of them forgets it.
  assert.deepEqual(tests[0]!.subjects, ['m1', 'u2']);
  assert.equal(await w.loop.reacted('https://discord.test/a2', '👎', true, 'm3'), 'count');
  const signals = (await items()).filter((i) => i!.type === 'signal');
  assert.deepEqual(signals.map((s) => s!.kind).sort(), ['approve', 'approve', 'approve', 'disapprove']);
  assert.ok(signals.every((s) => !('text' in s!)), 'a signal holds no words');
  // A member who asked to be forgotten is never recorded again.
  await w.memory.forget({ author: 'm3' });
  assert.equal(await w.loop.reacted('https://discord.test/a2', '👍', true, 'm3'), 'drop');
});

test('forgetting the member who approved an answer, or who asked it, forgets the test made from it', async () => {
  for (const who of ['asker', 'approver']) {
    const w = await loopWorld();
    const answerLabel = await w.store.put('private', { type: 'answer', text: 'x' });
    await w.loop.delivered({ sentUrl: 'https://discord.test/a9', question: 'How are Prism applications built from a LexLean model?', channelId: 'c1', authorId: 'asker', reply: { text: 'a', decision: 'answer', citations: cites, delivery: 'send', answer: answerLabel } });
    assert.equal(await w.loop.reacted('https://discord.test/a9', '👍', true, 'approver'), 'admit');
    await w.memory.forget({ author: who });
    const left = (await Promise.all((await w.store.labels('private')).map((l) => w.store.get('private', l)))).filter(Boolean);
    assert.ok(!left.some((i) => i!.type === 'test-case' || i!.type === 'signal'), `forgetting the ${who} leaves no test and no signal`);
    // The asker's own delivery stays when only the approver is forgotten; forgetting the asker leaves no trace.
    if (who === 'asker') assert.ok(!JSON.stringify(left).includes('LexLean model?'), 'forgetting the asker leaves no record of the question');
  }
});

test('retention removes what the loop made from members after the limit, and keeps Q\'s own records', async () => {
  const w = await loopWorld();
  await w.loop.restore();
  const answerLabel = await w.store.put('private', { type: 'answer', text: 'x' });
  w.clock.now = w.memory.now();
  await w.loop.delivered({ questionUrl: 'https://discord.test/q5', sentUrl: 'https://discord.test/r5', question: 'Where is the ledger?', channelId: 'c1', authorId: 'asker', reply: { text: 'no', decision: 'not grounded', citations: [], delivery: 'send', answer: answerLabel } });
  await w.loop.feedback({ kind: 'idea', text: 'Summarise the governance channel', authorId: 'a', channelId: 'c1' });
  const types = async () => (await Promise.all((await w.store.labels('private')).map((l) => w.store.get('private', l)))).filter(Boolean).map((i) => i!.type);
  assert.ok((await types()).includes('gap'));
  // The world's memory keeps 30 days: on day 31 every record made from a member is gone.
  w.memory.now = () => w.clock.now + 31 * 86_400_000;
  await w.memory.sweep();
  const left = await types();
  for (const type of ['gap', 'delivery', 'feedback', 'request']) assert.ok(!left.includes(type), `${type} is past retention`);
  assert.ok(left.includes('genome'), "Q's own lineage is kept");
});

test('a request is filed to the community once enough members ask for it, once, and never without consent', async () => {
  const w = await loopWorld();
  const first = await w.loop.feedback({ kind: 'idea', text: 'Please add a command that summarises the governance channel each week', authorId: 'a', channelId: 'c1' });
  assert.match(first, /opens a new request.*once 2 members ask/s);
  assert.equal(w.filed.length, 0);
  // The same member again does not count twice.
  await w.loop.feedback({ kind: 'idea', text: 'Please add a command that summarises the governance channel each week', authorId: 'a', channelId: 'c1' });
  assert.equal(w.filed.length, 0);
  // A second member asking the same thing supports it, and it is filed.
  const second = await w.loop.feedback({ kind: 'idea', text: 'Please add a command that summarises the governance channel each week', authorId: 'b', channelId: 'c2' });
  assert.match(second, /joins a request 1 other member made.*filed for the community/s);
  assert.equal(w.filed.length, 1);
  assert.equal(w.filed[0].supporters, 2);
  assert.ok(isLabel(w.filed[0].label));
  // A third does not file it again.
  await w.loop.feedback({ kind: 'idea', text: 'Please add a command that summarises the governance channel each week', authorId: 'c', channelId: 'c3' });
  assert.equal(w.filed.length, 1);
  // A different request, or a different kind, is its own request.
  await w.loop.feedback({ kind: 'problem', text: 'Answers about LexLean cite the wrong page', authorId: 'b', channelId: 'c2' });
  assert.equal(w.filed.length, 1);
  // The kernel never files without consent, nor twice.
  assert.equal(await kernel.fileRequest(false, 5, 2, false), 'hold');
  assert.equal(await kernel.fileRequest(true, 5, 2, true), 'hold');
  assert.equal(await kernel.fileRequest(true, 1, 2, false), 'hold');
});

/** A member's reply to Q's message, in a labelled public channel unless said otherwise. */
const replying = (to: string, text: string, more: Partial<Observed> = {}) => said(text, { replyTo: to, origin: 'request', url: `https://discord.test/c1/reply-${text.length}-${more.authorId ?? 'u1'}`, ...more });
const all = async (store: MemoryStore) => (await Promise.all((await store.labels('private')).map(async (l) => ({ label: l, item: await store.get('private', l) })))).filter((x) => x.item);

test('a reply that corrects Q is learned only with its author\'s 👎 and a second member, then found by the question and tested', async () => {
  const w = await loopWorld();
  const question = 'Which file registers the claim IDs?';
  // Q answered from a Discord message, the least trusted source: a confirmed correction is learned over it.
  const answerLabel = await w.store.put('private', { type: 'answer', text: 'x' });
  await w.loop.delivered({ questionUrl: 'https://discord.test/c1/q7', sentUrl: 'https://discord.test/c1/r7', question, channelId: 'c1', authorId: 'asker',
    reply: { text: 'a', decision: 'answer', citations: [{ ...cites[0], source: 'discord', level: 'open' }], delivery: 'send', answer: answerLabel, area: 'q › model' } });
  const correction = replying('https://discord.test/c1/r7', 'Wrong file: claim IDs are registered in model/ids.toml, one row each.', { authorId: 'fixer' });
  assert.equal(await w.memory.observe(correction), 'skip', 'a reply to Q is a request, never indexed by decision 2');
  assert.equal(await w.loop.observed(correction, 'skip'), 'keep');
  // Not yet a correction: no disapproval, and nobody confirmed it.
  assert.ok(!(await all(w.store)).some((x) => x.item!.type === 'correction'));
  assert.equal(await w.loop.reacted('https://discord.test/c1/r7', '👎', true, 'fixer'), 'count');
  assert.ok(!(await all(w.store)).some((x) => x.item!.type === 'correction'), 'its author alone cannot make it a correction');
  // The author's own 👍 on their reply does not count as a second member.
  assert.equal(await w.loop.reacted(correction.url, '👍', true, 'fixer'), 'hold');
  assert.equal(await w.loop.reacted(correction.url, '👍', true, 'second'), 'learn');
  const records = await all(w.store);
  const learned = records.find((x) => x.item!.type === 'correction')!.item!;
  assert.equal(learned.outcome, 'learn');
  assert.deepEqual(learned.subjects, ['asker', 'fixer', 'second']);
  const test = records.find((x) => x.item!.type === 'test-case')!.item!;
  assert.equal(test.cites, learned.chunk);
  // The next person who asks gets the member's answer, cited, at the open level.
  const answered = await w.pipeline.handle(ask(question, { authorId: 'next' }));
  assert.ok(answered!.citations.some((c) => c.label === learned.chunk), 'the correction is cited for the question');
  assert.match(answered!.text, /Claim level: open/);
  // Forgetting the member who confirmed it undoes the learning: the correction, its test and its chunk go.
  await w.memory.forget({ author: 'second' });
  const after = await all(w.store);
  assert.ok(!after.some((x) => x.item!.type === 'correction' || x.item!.type === 'test-case'));
  assert.ok(!(await w.store.has('private', String(learned.chunk))) && !w.index.has(String(learned.chunk)), 'the learned words are no longer searched');
  const why = after.filter((x) => x.item!.type === 'revocation').map((x) => x.item!.reason);
  assert.ok(why.includes('forget-me') && why.includes('unlearned'));
});

test('a confirmed correction of a more trusted source is a dispute for people, and an admin needs no second member', async () => {
  const w = await loopWorld();
  const answerLabel = await w.store.put('private', { type: 'answer', text: 'x' });
  await w.loop.delivered({ sentUrl: 'https://discord.test/c1/r8', question: 'How are Prism apps built?', channelId: 'c1', authorId: 'asker',
    reply: { text: 'a', decision: 'answer', citations: [{ ...cites[0], source: 'community', url: 'https://github.com/UOR-Foundation/community/blob/aaaa/docs/build.md' }], delivery: 'send', answer: answerLabel } });
  const reply = replying('https://discord.test/c1/r8', 'That page is out of date: prism-code build is the command now.', { authorId: 'admin1', role: 'admin' });
  assert.equal(await w.loop.observed(reply, 'skip'), 'keep');
  assert.equal(await w.loop.reacted('https://discord.test/c1/r8', '❌', true, 'admin1'), 'count');
  const disputed = (await all(w.store)).find((x) => x.item!.type === 'correction')!;
  assert.equal(disputed.item!.outcome, 'dispute', "never learned over the community's own source");
  const { review } = await w.loop.review(null);
  assert.ok(review.proposals.some((p) => p.kind === 'dispute' && p.subject === disputed.label && p.why.includes('docs/build.md')));
  // A reply in a channel Q may not read keeps no words, and so can never become a correction.
  await w.loop.delivered({ sentUrl: 'https://discord.test/c1/r9', question: 'q', channelId: 'c1', authorId: 'asker', reply: { text: 'a', decision: 'answer', citations: cites, delivery: 'send', answer: answerLabel } });
  const hidden = replying('https://discord.test/c1/r9', 'A correction in an unlabelled channel', { authorId: 'admin1', role: 'admin', channel: open });
  assert.equal(await w.loop.observed(hidden, 'skip'), 'count');
  assert.ok(!(await all(w.store)).some((x) => x.item!.type === 'reply' && x.item!.url === hidden.url));
  // A reply its author deletes is withdrawn with everything kept of it.
  const gone = replying('https://discord.test/c1/r9', 'I take this back', { authorId: 'u5' });
  await w.loop.observed(gone, 'skip');
  assert.equal(await w.memory.withdraw(gone.url, gone), 1);
  assert.ok(!(await all(w.store)).some((x) => x.item!.type === 'reply' && x.item!.url === gone.url));
});

test('an evolved genome that answers a question Q must refuse is never promoted, however much it gains', async () => {
  assert.equal(await kernel.promote(0, 50, 5, 10, 60, 0, 0), 'promote');
  assert.equal(await kernel.promote(0, 50, 5, 10, 60, 0, 1), 'keep');
  assert.equal(await kernel.promote(50, 0, 5, 10, 60, 0, 0), 'keep');
});

test('the original answer shape keeps the original prompt label, so no stored answer key changes', async () => {
  const original = await readFile(new URL('./fixtures/prompt-before-styles.txt', import.meta.url), 'utf8');
  const router = /const ROUTER = `([\s\S]*?)`;/.exec(await readFile(new URL('../src/pipeline.ts', import.meta.url), 'utf8'))![1];
  assert.equal(promptOf(0), labelOf({ type: 'prompt', system: original, router }));
  assert.notEqual(promptOf(1), promptOf(0));
  // Every shape keeps the grounding rules word for word: no gene can loosen them.
  const grounding = original.slice(0, original.indexOf('Shape every answer'));
  for (let style = 0; style < STYLES.length; style++) assert.ok(systemFor(style).startsWith(grounding) && systemFor(style).endsWith(original.slice(original.indexOf('Write for a reader'))));
});

test('a question is classed by the public area of its nearest public item', () => {
  assert.equal(areaOf('https://github.com/UOR-Foundation/community/blob/aaaa/apps/uor-test-naming.prompt.json'), 'community › apps');
  assert.equal(areaOf('https://github.com/UOR-Foundation/q/blob/main/README.md'), 'q');
  assert.equal(areaOf('https://raw.githubusercontent.com/UOR-Foundation/prism/main/docs/start.md'), 'prism › docs');
  assert.equal(areaOf('https://www.uor.foundation/prism/start'), 'uor.foundation › prism');
  assert.equal(areaOf('https://example.test/'), 'example.test');
});

test('the self-model is recomputed from the records it names; a forgotten record shows as forgotten, a changed one as tampered', async () => {
  const w = await loopWorld();
  await w.loop.restore();
  const answerLabel = await w.store.put('private', { type: 'answer', text: 'x' });
  const ask3 = ['How are Prism applications built?', 'What is a holo?', 'Who maintains the community repository?'];
  for (const [i, q] of ask3.entries()) {
    await w.loop.delivered({ sentUrl: `https://discord.test/s/${i}`, question: q, channelId: 'c1', authorId: `asker${i}`, reply: { text: 'a', decision: i === 2 ? 'not grounded' : 'answer', citations: i === 2 ? [] : cites, delivery: 'send', answer: answerLabel, area: 'community › docs' } });
  }
  await w.loop.reacted('https://discord.test/s/0', '👍', true, 'fan');
  await w.loop.reacted('https://discord.test/s/1', '👎', true, 'critic');
  const { label, review } = await w.loop.review(null);
  const docs = review.competence.find((c) => c.area === 'community › docs')!;
  assert.deepEqual([docs.asked, docs.answered, docs.refused, docs.approved, docs.disapproved], [3, 2, 1, 1, 1]);
  assert.equal(docs.wrongPct, 50);
  assert.equal(review.classes.find((c) => c.area === 'community › docs')!.route, 'needs correction');
  assert.ok(review.proposals.some((p) => p.kind === 'class' && p.subject === 'community › docs'));
  assert.equal((await verifyReview(w.store, label)).ok, true);
  // A member forgotten since: their records are counted as forgotten, and the counts may only have fallen.
  await w.memory.forget({ author: 'asker1' });
  const after = await verifyReview(w.store, label);
  assert.ok(after.ok && after.forgotten > 0, JSON.stringify(after));
  // A record whose bytes change is caught by its label.
  const fan = (await all(w.store)).find((x) => x.item!.type === 'signal' && x.item!.author === 'fan')!;
  w.store.items.private.set(fan.label, JSON.stringify({ ...fan.item, kind: 'disapprove' }));
  const tampered = await verifyReview(w.store, label);
  assert.ok(!tampered.ok && tampered.tampered.includes(fan.label));
  // Anyone can ask who Q is, and the answer holds no member's words.
  const intro = await w.loop.introduction();
  assert.match(intro, /What I am[\s\S]*What I know[\s\S]*How I answer[\s\S]*What I cannot do[\s\S]*How I changed/);
  for (const q of ask3) assert.ok(!intro.includes(q));
  const event = w.events.at(-1) as { data: { competence: { area: string; route: string }[] } };
  assert.equal(event.data.competence[0].route, 'needs correction');
});

test('every record and event of the self-improvement loop matches its published schema exactly', async () => {
  const w = await loopWorld();
  await w.loop.restore();
  const answerLabel = await w.store.put('private', { type: 'answer', text: 'x' });
  for (const [i, q] of ['How are Prism applications built from a LexLean model?', 'What does a Prism application build from its LexLean model?', 'How is a LexLean model built into a Prism application?'].entries()) {
    await w.loop.delivered({ sentUrl: `https://discord.test/c1/k${i}`, question: q, channelId: 'c1', authorId: `a${i}`, reply: { text: 'a', decision: 'answer', citations: [{ ...cites[0], source: 'discord', level: 'open' }], delivery: 'send', answer: answerLabel, area: 'community › docs', timings: { embed: 3, answer: 40 } } });
    await w.loop.reacted(`https://discord.test/c1/k${i}`, '👍', true, 'fan');
  }
  const reply = replying('https://discord.test/c1/k0', 'Prism apps are built with prism-code build from the model.', { authorId: 'fixer' });
  await w.loop.observed(reply, 'skip');
  await w.loop.reacted('https://discord.test/c1/k0', '👎', true, 'fixer');
  await w.loop.reacted(reply.url, '✅', true, 'second');
  await w.loop.daily();
  const types: Record<string, string> = { delivery: 'delivery', signal: 'signal', reply: 'reply', correction: 'correction', 'test-case': 'test-case', genome: 'genome', review: 'review' };
  const seen = new Set<string>();
  for (const { item } of await all(w.store)) {
    const name = types[item!.type];
    if (!name) continue;
    seen.add(name);
    const s = await schema(name);
    assert.deepEqual(conforms(item, s, s), [], `${item!.type} conforms`);
  }
  assert.deepEqual([...seen].sort(), Object.values(types).sort());
  const eventSchema = await schema('review-event');
  const event = w.events.find((e) => (e as { type: string }).type === 'org.uorfoundation.q.review');
  assert.deepEqual(conforms(event, eventSchema, eventSchema), []);
  // The validator can fail: a signal that carries words is refused.
  const signalSchema = await schema('signal');
  const signal = (await all(w.store)).find((x) => x.item!.type === 'signal')!.item;
  assert.ok(conforms({ ...signal, text: 'words' }, signalSchema, signalSchema).length > 0);
});

test('a promoted genome is undone by adopting its parent, recorded as a new genome naming why', async () => {
  const w = await loopWorld();
  const root = await w.loop.restore();
  const child = { ...w.live.settings, style: 1 };
  const promoted = await w.store.put('private', { type: 'genome', spec: 'uor-q/genome/1', parent: root, genes: { mediumSimilarity: child.mediumSimilarity, highSimilarity: child.highSimilarity, retrieve: child.retrieve, style: 1 }, evolution: null, at: w.clock.now + 1 });
  w.index.loopSet('genome', 'latest', { label: promoted, at: w.clock.now + 1 });
  w.live.settings = child;
  w.clock.now += 2;
  const reverted = await w.loop.revert();
  const genome = (await w.store.get('private', reverted!))!;
  assert.equal(genome.parent, promoted);
  assert.equal(genome.revertedTo, root);
  assert.equal(w.live.settings.style, 0);
});

test('a mutation is drawn from BLAKE3, stays within bounds, and keeps the high band above the medium band', () => {
  const genes = { mediumSimilarity: settings.mediumSimilarity, highSimilarity: settings.highSimilarity, retrieve: settings.retrieve, style: 0 };
  assert.deepEqual(mutate(genes, 'seed'), mutate(genes, 'seed'));
  const seen = new Set<string>();
  let g: Genes = genes;
  for (let i = 0; i < 500; i++) {
    g = mutate(g, `step-${i}`);
    seen.add(JSON.stringify(g));
    assert.ok(g.mediumSimilarity >= GENE_BOUNDS.mediumSimilarity[0] && g.mediumSimilarity <= GENE_BOUNDS.mediumSimilarity[1]);
    assert.ok(g.highSimilarity <= GENE_BOUNDS.highSimilarity[1] && g.highSimilarity >= g.mediumSimilarity + 0.049);
    assert.ok(g.retrieve >= GENE_BOUNDS.retrieve[0] && g.retrieve <= GENE_BOUNDS.retrieve[1]);
    assert.ok(Number.isInteger(g.style) && g.style >= 0 && g.style < STYLES.length);
  }
  assert.ok(seen.size > 20);
  // Every reviewed answer shape is reached, and a mutation always changes the genome.
  assert.equal(new Set([...seen].map((x) => JSON.parse(x).style)).size, STYLES.length);
  for (let i = 0; i < 50; i++) assert.notDeepEqual(mutate(genes, `m-${i}`), genes);
});

test('a day of the loop measures, tries one mutation the kernel judges, and writes a review chained to the last', async () => {
  const w = await loopWorld();
  const root = await w.loop.restore();
  assert.equal((await w.store.get('private', root))!.parent, null);
  const answerLabel = await w.store.put('private', { type: 'answer', text: 'x' });
  for (const [i, q] of ['How are Prism applications built from a LexLean model?', 'What does a Prism application build from its LexLean model?', 'How is a LexLean model built into a Prism application?'].entries()) {
    await w.loop.delivered({ sentUrl: `https://discord.test/a/${i}`, question: q, channelId: 'c1', authorId: 'u', reply: { text: 'a', decision: 'answer', citations: cites, delivery: 'send', answer: answerLabel } });
    assert.equal(await w.loop.reacted(`https://discord.test/a/${i}`, '👍', true, 'approver'), 'admit');
  }
  const first = await w.loop.daily();
  assert.ok(first.evolution, 'a mutation was tried');
  assert.ok(['promote', 'keep'].includes(first.evolution!.decision));
  assert.equal(first.review.previous, null);
  assert.equal(first.review.learning.tests, 3);
  assert.equal(first.review.identity.kernel.holo, kernel.holo);
  assert.equal(first.review.identity.kernel.vectors, kernel.vectors);
  const evaluation = (await w.store.get('private', first.review.evaluation!))!;
  assert.equal((evaluation.arm as { questions: number }).questions, 4);
  // The live settings always agree with the genome the lineage ends in.
  const genome = (await w.store.get('private', first.review.identity.genome!))!;
  assert.deepEqual(genome.genes, { mediumSimilarity: w.live.settings.mediumSimilarity, highSimilarity: w.live.settings.highSimilarity, retrieve: w.live.settings.retrieve, style: w.live.settings.style });
  w.clock.now += 86_400_000;
  const second = await w.loop.daily();
  assert.equal(second.review.previous, first.label);
  assert.ok(w.store.edges.private.some((e) => e.source === second.label && e.target === first.label && e.relation === 'derived-from'));
  const event = w.events.at(-1) as { data: Record<string, unknown> };
  assert.equal(event.data.kernel, kernel.holo);
  assert.ok(!JSON.stringify(event).includes('LexLean model'));
  assert.match(await w.loop.summary(), /Genome: generation \d+/);
});

test('a source is titled by what it is: a Discord message by channel and day, a page by site and path, a file by repository and path', () => {
  const now = new Date('2026-11-24T00:00:00Z');
  const names = (id: string) => (id === '1342910419370774532' ? 'general' : undefined);
  assert.equal(titleOf('https://discord.com/channels/1342910418754076732/1342910419370774532/1568005069897736314', names, now), '#general · 5 Nov');
  assert.equal(titleOf('https://discord.com/channels/1342910418754076732/1342910419370774532/1342914476701384835', names, now), '#general · 22 Feb 2025');
  assert.equal(titleOf('https://uor.foundation/blog/lexlean-v0-4.md', names, now), 'uor.foundation › blog/lexlean-v0-4');
  assert.equal(titleOf('https://github.com/UOR-Foundation/community/blob/95566d96ca6e71721788c9f9be9eb7e0876f1ab3/apps/uor-discord-read.prompt.json', names, now), 'community › apps/uor-discord-read');
  assert.equal(titleOf('https://raw.githubusercontent.com/UOR-Foundation/community/95566d9/governance/README.md', names, now), 'community › governance/README');
});

// The website: a third surface on the same pipeline.

const QUESTION = 'How are Prism applications built from a LexLean model?';
const onWeb = (text: string, more: Partial<Incoming> = {}): Incoming => ({ surface: 'web', channelId: 'web', authorId: 'web:v1', role: 'member', trigger: 'slash', command: 'ask', text, ...more });
const privateItems = async (store: MemoryStore) => Promise.all((await store.labels('private')).map(async (label) => ({ label, item: (await store.get('private', label))! })));

test('the website is a third surface: the kernel serves a public item there and withholds a private one', async () => {
  assert.equal(await kernel.expose('public', 'web'), 'serve');
  assert.equal(await kernel.expose('private', 'web'), 'withhold');
  assert.equal(await kernel.expose('private', 'discord'), 'serve');
});

test('a question on the website is answered from public sources only, and its public record holds no question and no author', async () => {
  const { pipeline, memory, store } = await world();
  await memory.observe(said('Prism applications are built from a LexLean model, with a secret detail said on Discord'));
  const reply = await pipeline.handle(onWeb(QUESTION));
  const { label, answer } = reply!.web!;
  assert.equal(label, labelOf(answer));
  assert.deepEqual(conforms(answer, await schema('web-answer'), await schema('web-answer')), []);
  assert.ok(answer.sources.length > 0);
  assert.ok(answer.sources.every((s) => s.source !== 'discord' && !s.url.includes('discord.test')));
  assert.equal(answer.kernel, kernel.holo);
  assert.doesNotMatch(JSON.stringify(reply!.web), /web:v1|secret detail|built from a LexLean model\?/);
  // On Discord the same question may cite the Discord message: the surface decides, not the question.
  const onDiscord = await pipeline.handle(ask(QUESTION, { authorId: 'd1' }));
  assert.ok(onDiscord!.citations.some((c) => c.source === 'discord'));
  // The turn's own records are private as on every surface, name the surface, and match the published schema.
  const turn = (await privateItems(store)).find(({ item }) => item.type === 'context' && (item.request as { surface: string }).surface === 'web')!;
  assert.deepEqual(conforms(turn.item, await schema('context'), await schema('context')), []);
  // Neither record's label is in what the website is sent: a label confirms that a known question exists.
  for (const { label: held, item } of await privateItems(store)) if (item.type === 'context' || item.type === 'answer') assert.ok(!JSON.stringify(reply!.web).includes(held));
});

test('a question key is the question and the manifest: a repeat is read back by key, with no retrieval, no model and no new record', async () => {
  const { pipeline, llm, store, embedder } = await world();
  let embedded = 0;
  const embed = embedder.embed.bind(embedder);
  embedder.embed = (texts: string[]) => { embedded++; return embed(texts); };
  const { label: manifestLabel, manifest } = await pipeline.manifest();
  assert.equal(manifestLabel, labelOf(manifest));
  assert.deepEqual(conforms(manifest, await schema('web-manifest'), await schema('web-manifest')), []);
  const first = (await pipeline.handle(onWeb(QUESTION)))!.web!;
  // A browser computes the same key from the question as typed and the manifest's label.
  const key = questionKey('  how are PRISM applications built   from a LexLean model? ', manifestLabel);
  assert.equal(first.answer.key, key);
  const before = { calls: llm.calls, embedded, records: (await store.labels('private')).length };
  assert.deepEqual(await pipeline.lookup(key), first);
  assert.deepEqual({ calls: llm.calls, embedded, records: (await store.labels('private')).length }, before);
  assert.equal(pipeline.metrics.get('lookup'), 1);
  assert.equal(await pipeline.lookup(questionKey('Something nobody asked', manifestLabel)), undefined);
  assert.equal(await pipeline.lookup('not a label'), undefined);
  // A refusal is the answer to its key too.
  const refused = (await pipeline.handle(onWeb('zzzz qqqq xxxx', { authorId: 'web:v2' })))!.web!;
  assert.deepEqual([refused.answer.outcome, refused.answer.level, refused.answer.sources], ['not grounded', null, []]);
  assert.deepEqual(await pipeline.lookup(refused.answer.key), refused);
  // The same question on Discord is no key of the website's: only a turn on the website is remembered by question key.
  const elsewhere = await world();
  await elsewhere.pipeline.handle(ask(QUESTION));
  assert.equal(await elsewhere.pipeline.lookup(questionKey(QUESTION, (await elsewhere.pipeline.manifest()).label)), undefined);
});

test('a new index is a new manifest, and a new key for every question; a Discord message changes neither', async () => {
  const { pipeline, store, index, embedder, memory } = await world();
  const before = await pipeline.manifest();
  const first = (await pipeline.handle(onWeb(QUESTION)))!.web!;
  await memory.observe(said('A Discord message about Prism applications'));
  assert.equal((await pipeline.manifest()).label, before.label);
  assert.deepEqual(await pipeline.lookup(first.answer.key), first);
  await ingest(fixture('github', 'some-true', [{ url: 'https://example.test/repo/readme', text: 'A new repository about content addressing.' }]), kernel, store, index, embedder);
  const after = await pipeline.manifest();
  assert.notEqual(after.manifest.corpus, before.manifest.corpus);
  assert.notEqual(after.label, before.label);
  assert.equal(await pipeline.lookup(first.answer.key), undefined);
  assert.notEqual(questionKey(QUESTION, after.label), first.answer.key);
});

test('an answer is known by its key only while every source it cites is still one the kernel cites', async () => {
  const { pipeline, store } = await world();
  const first = (await pipeline.handle(onWeb(QUESTION)))!.web!;
  const cited = first.answer.sources[0].label;
  assert.equal(labelOf((await pipeline.item(cited))!), cited);
  // Altered in the store, the item no longer has its label: the kernel drops it, and the answer goes with it.
  store.items.public.set(cited, store.items.public.get(cited)!.replace('"text":"', '"text":"Altered. '));
  assert.equal(await pipeline.item(cited), undefined);
  assert.equal(await pipeline.lookup(first.answer.key), undefined);
  // So does a revoked one.
  const other = await world();
  const second = (await other.pipeline.handle(onWeb(QUESTION)))!.web!;
  const revoked = second.answer.sources[0].label;
  await other.store.link('public', { source: revoked, target: revoked, relation: 'revocation' });
  assert.equal(await other.pipeline.lookup(second.answer.key), undefined);
});

test('words are shown as they are written, and never a refusal word, a discarded answer, or a text the filter could change', async () => {
  const watch = () => {
    const events: Progress[] = [];
    return { events, progress: (event: Progress) => { events.push(event); }, text: () => events.flatMap((e) => (e.stage === 'text' ? [e.delta] : [])).join('') };
  };
  const { pipeline, llm } = await world();
  const plain = watch();
  const reply = await pipeline.handle(onWeb(QUESTION, { progress: plain.progress }));
  assert.equal(plain.events[0].stage, 'sources');
  assert.ok(plain.events.some((e) => e.stage === 'text'));
  assert.equal(plain.text(), reply!.web!.answer.text);
  // A model that finds no answer says one word, which is never shown.
  llm.answer = 'NO_ANSWER';
  const none = watch();
  const declined = await pipeline.handle(onWeb('How are Prism applications verified by the Lean kernel?', { authorId: 'web:v2', progress: none.progress }));
  assert.equal(declined!.decision, 'declined');
  assert.equal(none.text(), '');
  assert.deepEqual([declined!.web!.answer.level, declined!.web!.answer.sources], [null, []]);
  // The plain answer written while a decision is read is discarded when there is one: only the decided answer is shown.
  llm.answer = undefined;
  const decision = watch();
  const decided = await pipeline.handle(onWeb('Is a lowercase repository name conformant under the repository naming rule?', { authorId: 'web:v3', progress: decision.progress }));
  assert.match(decision.text(), /^Decided answer/);
  assert.equal(decision.text(), decided!.web!.answer.text);
  assert.deepEqual(decided!.web!.answer.decision, { app: 'uor-test-naming', answer: 'conformant', commit: 'a'.repeat(40) });
  // With a filter term set, a word could be shown before the kernel decided on it: nothing is shown until it has.
  const filtered = await world({ filter: { scope: 'both', terms: ['forbidden'] } });
  filtered.llm.answer = 'Prism applications are built from a forbidden LexLean model [1].';
  const held = watch();
  const masked = await filtered.pipeline.handle(onWeb(QUESTION, { progress: held.progress }));
  assert.equal(held.text(), '');
  assert.match(masked!.web!.answer.text, /from a \*{9} LexLean model/);
});

test('the labels the website must compute are the ones this host computes: the shared vectors are current', async () => {
  const vectors = JSON.parse(await readFile(new URL('./fixtures/web-vectors.json', import.meta.url), 'utf8')) as {
    manifest: { record: never; label: string }; questions: { question: string; normalized: string; key: string }[]; answer: { record: never; label: string };
    thread: { question: string; after: string[]; key: string }[]; followUp: { record: { key: string; after: string[] }; label: string };
  };
  assert.equal(labelOf(vectors.manifest.record), vectors.manifest.label);
  assert.equal(labelOf(vectors.answer.record), vectors.answer.label);
  for (const { question, key } of vectors.questions) assert.equal(questionKey(question, vectors.manifest.label), key);
  // Case and spacing are one question; so are two spellings of the same accented letter.
  assert.equal(vectors.questions[0].key, vectors.questions[1].key);
  assert.equal(vectors.questions[2].key, vectors.questions[3].key);
  assert.notEqual(vectors.questions[0].key, vectors.questions[2].key);
  assert.deepEqual(conforms(vectors.answer.record, await schema('web-answer'), await schema('web-answer')), []);
  // A follow-up's key holds the keys before it; case and spacing are still one question; with none before it, it is the plain key.
  for (const { question, after, key } of vectors.thread) assert.equal(questionKey(question, vectors.manifest.label, after), key);
  assert.equal(vectors.thread[0].key, vectors.thread[1].key);
  assert.deepEqual(vectors.thread[2].after, [vectors.questions[0].key, vectors.thread[0].key]);
  assert.equal(vectors.thread[3].key, questionKey(vectors.thread[3].question, vectors.manifest.label));
  assert.notEqual(vectors.thread[3].key, vectors.thread[0].key);
  assert.equal(labelOf(vectors.followUp.record as never), vectors.followUp.label);
  assert.equal(vectors.followUp.record.key, vectors.thread[0].key);
  assert.deepEqual(conforms(vectors.followUp.record, await schema('web-answer'), await schema('web-answer')), []);
});

async function onTheWeb(options: Partial<WebOptions> & { withMcp?: boolean } = {}) {
  const made = await world();
  const bytes = new Uint8Array(await readFile(HOLO));
  const mcp: WebOptions['mcp'] = options.withMcp ? (asker, author) => mcpServer(asker, kernel, () => made.decider, author) : undefined;
  const server = webServer(made.pipeline, { origins: ['https://site.test'], suggestions: [QUESTION], concurrency: 1, kernel: { label: kernel.holo, bytes }, mcp, ...options });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { ...made, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
/** A response of server-sent events, as its events in order. */
const sse = async (response: Response) => (await response.text()).split('\n\n').filter(Boolean).map((block) => ({
  event: /^event: (.*)$/m.exec(block)![1],
  data: JSON.parse(/^data: (.*)$/m.exec(block)![1]) as Record<string, unknown>,
}));
const post = (base: string, question: string, headers: Record<string, string> = {}) => fetch(`${base}/ask`, { method: 'POST', headers: { 'content-type': 'text/plain', ...headers }, body: JSON.stringify({ question }) });

test("the website's adapter answers over HTTP: the manifest, a question as events, the answer again by its key, and a source by its label", async () => {
  const { server, base, llm, memory, store } = await onTheWeb();
  try {
    const origin = { origin: 'https://site.test' };
    const first = await (await fetch(`${base}/manifest`, { headers: origin })).json() as { label: string; suggestions: unknown; answers: Record<string, Published>; limits: unknown };
    const key = questionKey(QUESTION, first.label);
    assert.deepEqual(first.suggestions, [{ question: QUESTION, key }]);
    assert.deepEqual(first.answers, {});
    assert.deepEqual(first.limits, { question: QUESTION_LIMIT });
    // Asked as text/plain: a simple request, so a browser sends no preflight before it.
    const asked = await post(base, QUESTION, origin);
    assert.equal(asked.headers.get('access-control-allow-origin'), 'https://site.test');
    assert.match(asked.headers.get('content-type')!, /^text\/event-stream/);
    const events = await sse(asked);
    assert.deepEqual([...new Set(events.map((e) => e.event))], ['queued', 'decided', 'sources', 'text', 'answer']);
    const sent = events.at(-1)!.data as unknown as Published & { ms: number; timings: Record<string, number> };
    assert.equal(sent.answer.key, key);
    assert.equal(sent.label, labelOf(sent.answer));
    assert.equal(events.flatMap((e) => (e.event === 'text' ? [e.data.delta] : [])).join(''), sent.answer.text);
    assert.ok(Number.isInteger(sent.ms) && typeof sent.timings.embed === 'number');
    // The same answer by its key: one GET, no question text, no model.
    const again = await fetch(`${base}/answer/${key}`, { headers: origin });
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), { label: sent.label, answer: sent.answer });
    assert.equal(llm.calls, 1);
    // A suggested question's answer, once computed, comes with the manifest.
    const second = await (await fetch(`${base}/manifest`)).json() as typeof first;
    assert.equal(second.answers[key].label, sent.label);
    // A source by its label is the item itself, so a visitor can recompute the label.
    const source = sent.answer.sources[0].label;
    assert.equal(labelOf(await (await fetch(`${base}/item/${source}`)).json() as never), source);
    // A Discord item has a label too, and is not served.
    await memory.observe(said('A private message on Discord about Prism applications'));
    const [hidden] = (await privateItems(store)).filter(({ item }) => item.type === 'chunk');
    assert.ok(hidden);
    assert.equal((await fetch(`${base}/item/${hidden.label}`)).status, 404);
    assert.equal((await fetch(`${base}/answer/${questionKey('never asked', first.label)}`)).status, 404);
    // The kernel this host runs, by its label: the same bytes, so a browser can run the same decisions.
    const served = new Uint8Array(await (await fetch(`${base}/kernel/${kernel.holo}`)).arrayBuffer());
    assert.deepEqual(served, new Uint8Array(await readFile(HOLO)));
    assert.equal((await fetch(`${base}/kernel/${labelOf({ type: 'holo', name: 'another' })}`)).status, 404);
    assert.equal((await fetch(`${base}/nothing`)).status, 404);
  } finally {
    server.close();
  }
});

test("the website's adapter refuses another site's page, a question too long, and a visitor past the rate limit", async () => {
  const { server, base } = await onTheWeb();
  try {
    assert.equal((await fetch(`${base}/manifest`, { headers: { origin: 'https://elsewhere.test' } })).status, 403);
    assert.equal((await post(base, QUESTION, { origin: 'https://elsewhere.test' })).status, 403);
    assert.equal((await post(base, 'x'.repeat(QUESTION_LIMIT + 1))).status, 400);
    assert.equal((await fetch(`${base}/ask`, { method: 'POST', body: 'not json' })).status, 400);
    const preflight = await fetch(`${base}/ask`, { method: 'OPTIONS', headers: { origin: 'https://site.test' } });
    assert.deepEqual([preflight.status, preflight.headers.get('access-control-allow-origin')], [204, 'https://site.test']);
    // The kernel's rate limit (decision 5) is the visitor's: three questions a minute here, then a refusal with no answer.
    for (let asked = 0; asked < 3; asked++) assert.equal((await sse(await post(base, QUESTION))).at(-1)!.event, 'answer');
    const fourth = await sse(await post(base, QUESTION));
    assert.deepEqual(fourth.map((e) => e.event), ['queued', 'refused']);
    assert.equal(fourth[1].data.decision, 'rate limited');
  } finally {
    server.close();
  }
});

test('another agent asks with one request: a page it can read, the record as JSON, and how to ask at the root', async () => {
  const { server, base, llm } = await onTheWeb();
  try {
    // The root says how to ask, at this host's own address. With no MCP server given, it offers none.
    const root = await fetch(`${base}/`);
    assert.match(root.headers.get('content-type')!, /^text\/markdown/);
    const manual = await root.text();
    assert.ok(manual.includes(`GET ${base}/ask?q=`));
    assert.ok(manual.includes(`at most ${QUESTION_LIMIT} characters`));
    assert.doesNotMatch(manual, /\/mcp/);
    assert.equal(await (await fetch(`${base}/llms.txt`)).text(), manual);
    assert.equal((await fetch(`${base}/mcp`, { method: 'POST', body: '{}' })).status, 404);
    // One GET, as any fetch tool sends it: the answer as Markdown, its sources by address, and where to read it again.
    const asked = `${base}/ask?q=${encodeURIComponent(QUESTION)}`;
    const page = await fetch(asked);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type')!, /^text\/markdown/);
    const text = await page.text();
    const key = questionKey(QUESTION, (await (await fetch(`${base}/manifest`)).json() as { label: string }).label);
    assert.match(text, /## Sources\n\n1\. https:\/\/\S+ \(\w+, [\w-]+(, cited)?\) `blake3:[0-9a-f]{64}`\n/);
    assert.match(text, /\nClaim level: [\w-]+\. Grounding: answer, from the \w+ band and \d+ sources?\.\n/);
    assert.ok(text.includes(`${base}/answer/${key}`));
    // The same question as JSON is the record /answer/<key> serves, and the model was called once for all of it.
    const record = await (await fetch(asked, { headers: { accept: 'application/json' } })).json() as Published;
    assert.equal(record.label, labelOf(record.answer));
    // Headed, so a reader that skims cannot take the answer for a preamble.
    assert.ok(text.startsWith(`# Q's answer\n\n${record.answer.text}\n`));
    assert.match(text, /\n## How far it is established\n/);
    assert.deepEqual(record, await (await fetch(`${base}/answer/${key}`)).json());
    // A POST that accepts JSON is answered whole instead of as events, so the question stays out of the URL.
    const posted = await post(base, QUESTION, { accept: 'application/json' });
    assert.match(posted.headers.get('content-type')!, /^application\/json/);
    assert.deepEqual(await posted.json(), record);
    assert.equal(llm.calls, 1);
    // No question is told how to ask; the fourth question in a minute is told to wait; a wrong path is told where the manual is.
    const bare = await fetch(`${base}/ask`);
    assert.equal(bare.status, 400);
    assert.ok((await bare.text()).includes(`${base}/ask?q=`));
    const limited = await fetch(asked, { headers: { accept: 'application/json' } });
    assert.equal(limited.status, 429);
    assert.equal((await limited.json() as { refused: string }).refused, 'rate limited');
    assert.deepEqual(await (await fetch(`${base}/nothing`)).json(), { error: 'not found', manual: `${base}/` });
  } finally {
    server.close();
  }
});

// A conversation on the website: follow-ups by key, a spoken register, and a question given up.

const PROVED = 'Prism applications are built from a LexLean model and proved by the Lean kernel [1].';
const FOLLOW = 'And who checks them?';
/** Every prompt the writer is given, in order, beside the model's own behaviour. */
const watched = (llm: CountingLlm) => {
  const seen: { system: string; user: string }[] = [];
  const complete = llm.complete.bind(llm);
  llm.complete = (system: string, user: string, onText?: (delta: string) => void) => {
    if (!system.startsWith('You read a question for the inputs')) seen.push({ system, user });
    return complete(system, user, onText);
  };
  return seen;
};

test('an earlier answer on the website is context only when it is still known by its key and among the newest three', async () => {
  assert.equal(await kernel.thread(true, true), 'use');
  assert.equal(await kernel.thread(false, true), 'skip');
  assert.equal(await kernel.thread(true, false), 'skip');
  assert.equal(await kernel.thread(false, false), 'skip');
});

test('a follow-up on the website builds on the answer it names by key, is found by reading the two together, and has a key of its own', async () => {
  const { pipeline, llm, store } = await world();
  llm.answer = PROVED;
  const prompts = watched(llm);
  const { label } = await pipeline.manifest();
  const first = (await pipeline.handle(onWeb(QUESTION)))!.web!;
  assert.ok(!('after' in first.answer));
  // Alone, the follow-up names nothing to look for, and nothing is claimed.
  const alone = (await pipeline.handle(onWeb(FOLLOW, { authorId: 'web:v2' })))!.web!;
  assert.deepEqual([alone.answer.outcome, alone.answer.level, alone.answer.key], ['not grounded', null, questionKey(FOLLOW, label)]);
  // After the first answer, retrieval reads the two together and the writer is given that answer's words.
  const follow = (await pipeline.handle(onWeb(FOLLOW, { after: [first.answer.key] })))!.web!;
  assert.notEqual(follow.answer.level, null);
  assert.deepEqual(follow.answer.after, [first.answer.key]);
  assert.equal(follow.answer.key, questionKey(FOLLOW, label, [first.answer.key]));
  assert.equal(follow.label, labelOf(follow.answer));
  assert.deepEqual(conforms(follow.answer, await schema('web-answer'), await schema('web-answer')), []);
  const prompt = prompts.at(-1)!.user;
  assert.match(prompt, /^Earlier in this conversation \(context for the question; cite only the sources\):\n\nYour answer: Prism applications are built from a LexLean model and proved by the Lean kernel \[1\]\.\n\nSources:/);
  // Only Q's own words are context: the question asked before is not, whoever asked it.
  assert.ok(!prompt.includes(QUESTION));
  assert.ok(prompt.endsWith(`Question: ${FOLLOW}`));
  // An answer with history is never the answer to the question alone: the plain key still names the refusal.
  assert.notEqual(follow.answer.key, alone.answer.key);
  assert.deepEqual(await pipeline.lookup(alone.answer.key), alone);
  assert.deepEqual(await pipeline.lookup(follow.answer.key), follow);
  // The same follow-up after the same answer is the same computation: read back, not written again.
  const calls = llm.calls;
  assert.deepEqual(await pipeline.lookup(questionKey(`  ${FOLLOW.toUpperCase()} `, label, [first.answer.key])), follow);
  assert.equal(llm.calls, calls);
  // The turn's private record names the earlier answer by its record's label, which the website is never sent.
  const turn = (await privateItems(store)).find(({ item }) => item.type === 'context' && (item.request as { question: string }).question === FOLLOW && (item.history as string[]).length === 1)!;
  assert.deepEqual(conforms(turn.item, await schema('context'), await schema('context')), []);
  const earlier = (turn.item.history as string[])[0];
  assert.equal((await store.get('private', earlier))!.text, PROVED);
  assert.ok(!JSON.stringify(follow).includes(earlier));
});

test('the kernel skips a key this host does not know, a refusal, a key of the other register, and all but the newest three', async () => {
  const { pipeline, llm } = await world({ userLimit: 20 });
  llm.answer = PROVED;
  const { label } = await pipeline.manifest();
  // Never asked: nothing is admitted, so the answer stands alone under the question's own key.
  const unknown = (await pipeline.handle(onWeb(QUESTION, { after: [questionKey('never asked', label)] })))!.web!;
  assert.ok(!('after' in unknown.answer));
  assert.equal(unknown.answer.key, questionKey(QUESTION, label));
  // A refusal claims nothing, so there is nothing to build on.
  const refused = (await pipeline.handle(onWeb('zzzz qqqq xxxx')))!.web!;
  assert.equal(refused.answer.level, null);
  const afterRefusal = (await pipeline.handle(onWeb('What proves a Prism application?', { after: [refused.answer.key] })))!.web!;
  assert.ok(!('after' in afterRefusal.answer));
  // An answer written to be heard is no part of a conversation that is read, and the other way round.
  const heard = (await pipeline.handle(onWeb(QUESTION, { register: 'spoken' })))!.web!;
  const mixed = (await pipeline.handle(onWeb('Which kernel proves a Prism application?', { after: [heard.answer.key] })))!.web!;
  assert.ok(!('after' in mixed.answer));
  const spokenFollow = (await pipeline.handle(onWeb('Which kernel proves a Prism application?', { register: 'spoken', after: [heard.answer.key, unknown.answer.key] })))!.web!;
  assert.deepEqual(spokenFollow.answer.after, [heard.answer.key]);
  // Four known answers presented: the newest three are context, oldest first.
  const keys = [unknown.answer.key];
  for (const question of ['How is a Prism application proved?', 'Which model is a Prism application built from?', 'What kind of archive is a Prism application?']) {
    keys.push((await pipeline.handle(onWeb(question, { after: [...keys] })))!.web!.answer.key);
  }
  const fifth = (await pipeline.handle(onWeb('Is a Prism application self-verifying?', { after: keys })))!.web!;
  assert.equal(keys.length, 4);
  assert.deepEqual(fifth.answer.after, keys.slice(1));
  assert.equal(fifth.answer.key, questionKey('Is a Prism application self-verifying?', label, keys.slice(1)));
});

test('the spoken register is a second prompt and a second manifest: its answers have their own keys, and no written key changes', async () => {
  const { pipeline, llm, store } = await world();
  const prompts = watched(llm);
  const [written, spoken] = [await pipeline.manifest(), await pipeline.manifest('spoken')];
  assert.notEqual(spoken.label, written.label);
  assert.deepEqual({ ...spoken.manifest, prompt: written.manifest.prompt }, written.manifest);
  assert.deepEqual(conforms(spoken.manifest, await schema('web-manifest'), await schema('web-manifest')), []);
  const read = (await pipeline.handle(onWeb(QUESTION)))!.web!;
  const heard = (await pipeline.handle(onWeb(QUESTION, { authorId: 'web:v2', register: 'spoken' })))!.web!;
  // One question, two computations: the answer to be heard is written anew, never read back from the one to be read.
  assert.equal(llm.calls, 2);
  assert.match(prompts[0].system, /on its Discord server/);
  assert.match(prompts[1].system, /speaking aloud with a visitor on its website/);
  assert.match(prompts[1].system, /reply with exactly NO_ANSWER and nothing else/);
  assert.deepEqual([read.answer.manifest, read.answer.key], [written.label, questionKey(QUESTION, written.label)]);
  assert.deepEqual([heard.answer.manifest, heard.answer.key], [spoken.label, questionKey(QUESTION, spoken.label)]);
  assert.deepEqual(await pipeline.lookup(read.answer.key), read);
  assert.deepEqual(await pipeline.lookup(heard.answer.key), heard);
  // The turn's private record says which register it was, and only when it is the spoken one.
  const turns = (await privateItems(store)).filter(({ item }) => item.type === 'context').map(({ item }) => item.request as { register?: string });
  assert.deepEqual(turns.map((request) => request.register).sort(), ['spoken', undefined]);
  for (const { item } of (await privateItems(store)).filter(({ item }) => item.type === 'context')) assert.deepEqual(conforms(item, await schema('context'), await schema('context')), []);
  // Off the website there is one register: Discord is written to, whatever a message says.
  await pipeline.handle(ask(`${QUESTION} And by what are they proved?`, { authorId: 'd1', register: 'spoken' }));
  assert.equal(llm.calls, 3);
  assert.match(prompts.at(-1)!.system, /on its Discord server/);
});

test('a question given up is not answered: the model call is aborted, nothing is recorded, and the visitor may ask again at once', async () => {
  const { pipeline, llm, store } = await world();
  const { label } = await pipeline.manifest();
  const gone = new AbortController();
  let given: AbortSignal | undefined;
  const complete = llm.complete.bind(llm);
  // A model still writing when the visitor leaves: it stops only when its call is aborted.
  llm.complete = (system: string, user: string, onText?: (delta: string) => void, signal?: AbortSignal) => {
    if (system.startsWith('You read a question for the inputs')) return complete(system, user);
    given = signal;
    onText?.('Prism ');
    return new Promise<string>((_, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason));
      setTimeout(() => gone.abort(), 5);
    });
  };
  const shown: string[] = [];
  await assert.rejects(pipeline.handle(onWeb(QUESTION, { signal: gone.signal, progress: (stage) => { if (stage.stage === 'text') shown.push(stage.delta); } })), { name: 'AbortError' });
  assert.ok(given?.aborted);
  assert.equal((await privateItems(store)).filter(({ item }) => item.type === 'answer').length, 0);
  assert.equal(await pipeline.lookup(questionKey(QUESTION, label)), undefined);
  assert.equal(pipeline.load, 0);
  // A question given up before its turn came is not asked at all: no model call, no record, no count against the limit.
  const before = (await store.labels('private')).length;
  given = undefined;
  await assert.rejects(pipeline.handle(onWeb(QUESTION, { signal: gone.signal })), { name: 'AbortError' });
  assert.equal(given, undefined);
  assert.equal((await store.labels('private')).length, before);
  // The same visitor asks again and is answered: the turn that was given up holds no place.
  llm.complete = complete;
  const again = (await pipeline.handle(onWeb(QUESTION)))!.web!;
  assert.equal(again.answer.key, questionKey(QUESTION, label));
  assert.deepEqual(await pipeline.lookup(again.answer.key), again);
});

test('tool-enabled provider honors its round limit even when the final response still requests a tool', async () => {
  const requests: Record<string, unknown>[] = [];
  const transport = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: 'call-' + requests.length, type: 'function', function: { name: 'lookup', arguments: '{}' } }] } }] });
  }) as typeof fetch;
  const llm = new OpenAiCompatibleLlm('http://model.test/v1', 'key', 'model', false, 64, 1, transport);
  let calls = 0;
  const run = async () => { calls++; return 'result'; };
  const specs = [{ name: 'lookup', description: 'lookup', parameters: { type: 'object' } }];
  await assert.rejects(llm.completeWithTools('system', 'user', specs, run, 1), /tool rounds were exhausted/);
  assert.equal(calls, 1);
  assert.equal(requests.length, 2);
  assert.ok(requests[0].tools);
  assert.equal(requests[1].tools, undefined);
  await assert.rejects(llm.completeWithTools('system', 'user', specs, run, 0), /tool rounds were exhausted/);
  assert.equal(calls, 1);
  assert.equal(requests.length, 3);
  await assert.rejects(llm.completeWithTools('system', 'user', specs, run, -1), /invalid tool round limit/);
  assert.equal(requests.length, 3);
});

test('tool-enabled provider does not dispatch malformed argument payloads', async () => {
  const requests: Record<string, unknown>[] = [];
  const malformed = ['', '{', 'null', '[]', '1', '"text"'];
  const transport = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    const message = requests.length === 1 ? { content: null, tool_calls: [...malformed, '{}'].map((argumentsText, i) => ({ id: 'call-' + i, type: 'function', function: { name: 'lookup', arguments: argumentsText } })) } : { content: 'answer' };
    return Response.json({ choices: [{ message }] });
  }) as typeof fetch;
  const llm = new OpenAiCompatibleLlm('http://model.test/v1', 'key', 'model', false, 64, 1, transport);
  const calls: ToolCall[] = [];
  const answer = await llm.completeWithTools('system', 'user', [{ name: 'lookup', description: 'lookup', parameters: { type: 'object' } }], async call => { calls.push(call); return 'result'; });
  assert.equal(answer, 'answer');
  assert.deepEqual(calls, [{ name: 'lookup', arguments: {} }]);
  const messages = requests[1].messages as { role: string; content: string }[];
  assert.deepEqual(messages.filter(m => m.role === 'tool').map(m => m.content), [...malformed.map(() => 'Refused: this tool is not allowed here.'), 'result']);
});

test('tool-enabled provider stops dispatching further calls after cancellation', async () => {
  const gone = new AbortController();
  let requests = 0;
  const transport = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests++;
    assert.equal(init?.signal, gone.signal);
    return Response.json({ choices: [{ message: { content: null, tool_calls: ['one', 'two'].map(id => ({ id, type: 'function', function: { name: 'lookup', arguments: '{}' } })) } }] });
  }) as typeof fetch;
  const llm = new OpenAiCompatibleLlm('http://model.test/v1', 'key', 'model', false, 64, 1, transport);
  let calls = 0;
  await assert.rejects(llm.completeWithTools('system', 'user', [{ name: 'lookup', description: 'lookup', parameters: { type: 'object' } }], async () => { calls++; gone.abort(); return 'result'; }, 3, gone.signal), { name: 'AbortError' });
  assert.equal(calls, 1);
  assert.equal(requests, 1);
});

test('a provider call that is aborted stops reading, fails, and gives its place to the next call', async () => {
  let reached = 0;
  const transport = ((_url: string | URL | Request, init?: RequestInit) => {
    reached++;
    if (reached === 1) return new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)));
    return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: 'A holo is a packaged app [1].' } }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  }) as typeof fetch;
  const llm = new OpenAiCompatibleLlm('http://model.test/v1', 'key', 'model', false, 64, 1, transport);
  const gone = new AbortController();
  const first = llm.complete('system', 'user', () => {}, gone.signal);
  // One call at a time here: the second waits for the first, and is answered once the first is given up.
  const second = llm.complete('system', 'user');
  gone.abort();
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(await second, 'A holo is a packaged app [1].');
  // A call already given up when its turn comes never reaches the network.
  await assert.rejects(llm.complete('system', 'user', undefined, gone.signal), { name: 'AbortError' });
  assert.equal(reached, 2);
});

test("the website's adapter serves each register its manifest, takes a follow-up by its keys, and refuses a request that is not one", async () => {
  const { server, base, llm } = await onTheWeb();
  llm.answer = PROVED;
  const send = (body: unknown) => fetch(`${base}/ask`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(body) });
  try {
    const written = await (await fetch(`${base}/manifest`)).json() as { label: string; suggestions: { key: string }[] };
    const spoken = await (await fetch(`${base}/manifest?register=spoken`)).json() as typeof written;
    assert.notEqual(spoken.label, written.label);
    assert.deepEqual(spoken.suggestions, [{ question: QUESTION, key: questionKey(QUESTION, spoken.label) }]);
    assert.equal((await (await fetch(`${base}/manifest?register=written`)).json() as typeof written).label, written.label);
    assert.equal((await fetch(`${base}/manifest?register=sung`)).status, 400);
    // A spoken question, then a spoken follow-up that names it by key.
    const first = (await sse(await send({ question: QUESTION, register: 'spoken' }))).at(-1)!.data as unknown as Published;
    assert.equal(first.answer.key, questionKey(QUESTION, spoken.label));
    const events = await sse(await send({ question: FOLLOW, register: 'spoken', after: [first.answer.key] }));
    assert.deepEqual([...new Set(events.map((e) => e.event))], ['queued', 'decided', 'sources', 'text', 'answer']);
    const follow = events.at(-1)!.data as unknown as Published;
    assert.deepEqual(follow.answer.after, [first.answer.key]);
    assert.equal(follow.answer.key, questionKey(FOLLOW, spoken.label, [first.answer.key]));
    // By its key the follow-up is read back like any answer, and under the question's own key there is none.
    assert.deepEqual(await (await fetch(`${base}/answer/${follow.answer.key}`)).json(), { label: follow.label, answer: follow.answer });
    assert.equal((await fetch(`${base}/answer/${questionKey(FOLLOW, spoken.label)}`)).status, 404);
    // A suggested question answered in the spoken register comes with the spoken manifest, not the written one.
    assert.deepEqual(Object.keys((await (await fetch(`${base}/manifest?register=spoken`)).json() as { answers: object }).answers), [first.answer.key]);
    assert.deepEqual((await (await fetch(`${base}/manifest`)).json() as { answers: object }).answers, {});
    for (const body of [
      { question: QUESTION, register: 'sung' },
      { question: QUESTION, after: 'blake3:' + '0'.repeat(64) },
      { question: QUESTION, after: ['not a label'] },
      { question: QUESTION, after: Array.from({ length: AFTER_LIMIT + 1 }, () => first.answer.key) },
      [QUESTION],
    ]) assert.equal((await send(body)).status, 400);
  } finally {
    server.close();
  }
});

test("the website's adapter gives up a question whose page closed the connection, and answers that visitor's next one", async () => {
  const { server, base, llm } = await onTheWeb();
  const complete = llm.complete.bind(llm);
  let stopped: () => void = () => {};
  const aborted = new Promise<void>((resolve) => { stopped = resolve; });
  llm.complete = (system: string, user: string, onText?: (delta: string) => void, signal?: AbortSignal) => {
    if (system.startsWith('You read a question for the inputs')) return complete(system, user);
    onText?.('Prism applications ');
    return new Promise<string>((_, reject) => signal!.addEventListener('abort', () => { stopped(); reject(signal!.reason); }));
  };
  try {
    const leaving = new AbortController();
    const response = await fetch(`${base}/ask`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ question: QUESTION }), signal: leaving.signal });
    const reader = response.body!.getReader();
    // The page hears the first words, then closes the connection, as it does when a visitor cuts in.
    let heard = '';
    while (!heard.includes('event: text')) heard += new TextDecoder().decode((await reader.read()).value);
    leaving.abort();
    await aborted;
    // One question at a time here: the next is answered only because the one given up let go of its place.
    llm.complete = complete;
    const next = await sse(await post(base, QUESTION));
    assert.equal(next.at(-1)!.event, 'answer');
    assert.equal(llm.calls, 1);
  } finally {
    server.close();
  }
});

test("Q's MCP server answers at /mcp of the website's adapter: a client connects with no session, and nothing from Discord is served", async () => {
  const { server, base, memory } = await onTheWeb({ withMcp: true });
  await memory.observe(said('Prism applications are discussed here on Discord with a secret detail'));
  const client = new Client({ name: 'another-agent', version: '1.0.0' });
  try {
    assert.ok((await (await fetch(`${base}/`)).text()).includes(`"url": "${base}/mcp"`));
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), ['ask', 'community_apps', 'community_decide', 'search', 'status']);
    const answered = (await client.callTool({ name: 'ask', arguments: { question: QUESTION } })).content as { text: string }[];
    assert.match(answered[0].text, /Claim level: /);
    const found = (await client.callTool({ name: 'search', arguments: { query: 'Prism applications self-verifying archives built from a LexLean model secret detail' } })).content as { text: string }[];
    assert.match(found[0].text, /example\.test\/site\/prism/);
    assert.doesNotMatch(found[0].text, /discord\.test|secret detail/);
    const status = JSON.parse(((await client.callTool({ name: 'status', arguments: {} })).content as { text: string }[])[0].text) as { kernel: { holo: string } };
    assert.equal(status.kernel.holo, kernel.holo);
    // No session and no stream: a GET is told so, and a body that is not JSON is a JSON-RPC parse error.
    const opened = await fetch(`${base}/mcp`);
    assert.deepEqual([opened.status, opened.headers.get('allow')], [405, 'POST']);
    const broken = await fetch(`${base}/mcp`, { method: 'POST', body: 'not json' });
    assert.deepEqual([broken.status, (await broken.json() as { error: { code: number } }).error.code], [400, -32700]);
    // A page on another site may not use it either.
    assert.equal((await fetch(`${base}/mcp`, { method: 'POST', headers: { origin: 'https://elsewhere.test' }, body: '{}' })).status, 403);
  } finally {
    await client.close();
    server.close();
  }
});

test('a streamed completion gives the answer as it arrives, never the reasoning, and returns the same whole answer', async () => {
  const pieces = ['<think>', 'weighing the sources', '</think>', '\n\nA holo ', 'is a packaged', ' app [1].'];
  const provider = createServer((request, response) => {
    let body = '';
    request.on('data', (part) => { body += part; });
    request.on('end', () => {
      if (!(JSON.parse(body) as { stream?: boolean }).stream) return response.end(JSON.stringify({ choices: [{ message: { content: pieces.join('') } }] }));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      // Sent in three parts that fall inside lines: a line is whole only at its newline.
      const lines = `${pieces.map((piece) => `data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`).join('')}: keep-alive\n\ndata: [DONE]\n\n`;
      const third = Math.floor(lines.length / 3);
      response.write(lines.slice(0, third));
      setTimeout(() => { response.write(lines.slice(third, 2 * third)); setTimeout(() => response.end(lines.slice(2 * third)), 5); }, 5);
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  try {
    const llm = new OpenAiCompatibleLlm(`http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`, 'key', 'model', true, 64, 1);
    const seen: string[] = [];
    const whole = await llm.complete('system', 'user', (delta) => seen.push(delta));
    assert.equal(whole, 'A holo is a packaged app [1].');
    assert.equal(seen.join(''), whole);
    assert.ok(seen.length > 1);
    assert.equal(await llm.complete('system', 'user'), whole);
  } finally {
    provider.close();
  }
  assert.deepEqual(['<thi', '<think>so far', 'Plain words', 'a</think> b'].map(visibleSoFar), ['', '', 'Plain words', 'b']);
});

// Apps from one prompt.
const tipSpec: AppSpec = {
  name: 'tip-advisor', title: 'Tip advisor', purpose: 'Suggest a tip.',
  fields: [{ name: 'service', values: ['poor', 'ok', 'great'] }, { name: 'party', values: ['small', 'large'] }],
  outcomes: ['10%', '15%', '18%', '20%'],
  rules: [{ when: { service: 'poor' }, then: '10%' }, { when: { service: 'great', party: 'large' }, then: '20%' }, { when: { service: 'great' }, then: '18%' }, { when: {}, then: '15%' }],
};

test('a spec is refused with its reason unless it is a sound decision table, and decided first match wins', () => {
  assert.deepEqual(checkSpec(tipSpec), tipSpec);
  const refuse = (change: object, why: RegExp) => assert.throws(() => checkSpec({ ...tipSpec, ...change }), why);
  refuse({ name: 'Tip Advisor' }, /slug/);
  refuse({ fields: [] }, /between 1 and 4 fields/);
  refuse({ outcomes: ['a', 'a'] }, /distinct/);
  refuse({ outcomes: ['invalid', 'b'] }, /not "invalid"/);
  refuse({ rules: [{ when: { service: 'superb' }, then: '10%' }, { when: {}, then: '15%' }] }, /superb is not a value/);
  refuse({ rules: [{ when: {}, then: '99%' }] }, /not a declared outcome/);
  refuse({ rules: [{ when: { service: 'poor' }, then: '10%' }] }, /last rule must name no field/);
  assert.equal(decideApp(tipSpec, ['great', 'large']), '20%');
  assert.equal(decideApp(tipSpec, ['great', 'small']), '18%');
  assert.equal(decideApp(tipSpec, ['poor', 'large']), '10%');
  assert.equal(decideApp(tipSpec, ['ok', 'large']), '15%');
});

test('the generated app states one theorem per rule, replays every combination as the table answers, and refuses malformed requests', () => {
  const files = generate(tipSpec);
  const model = files['app/src/Contract.lex.tex']!;
  for (const name of ['answersDeclared', 'rule1Decides', 'rule2Decides', 'rule3Decides', 'rule4Decides']) assert.match(model, new RegExp(`name: ${name},`));
  const vectors = [...model.matchAll(/request := 0x([0-9a-f]*), response := 0x([0-9a-f]*)/g)].map((m) => [Buffer.from(m[1], 'hex').toString(), Buffer.from(m[2], 'hex').toString()]);
  assert.equal(vectors.filter(([, r]) => r !== 'invalid').length, 6);
  for (const [request, response] of vectors.filter(([, r]) => r !== 'invalid')) assert.equal(response, decideApp(tipSpec, request.split(' ')));
  assert.ok(vectors.some(([q, r]) => q === '' && r === 'invalid'));
  assert.match(files['model/ids.toml']!, /^spec = "template\/2"$/m);
  assert.equal(files['features/suites/contract.feature'], null);
  // Text a person wrote never reaches the model unescaped.
  assert.doesNotMatch(generate({ ...tipSpec, title: 'A "quoted" \\ title' })['app/src/Contract.lex.tex']!, /"quoted"/);
});

test('the model designs a spec; one it gets wrong goes back once with the reason', async () => {
  const replies = ['Here you go: {"name":"Bad Name"}', JSON.stringify(tipSpec)];
  const asked: string[] = [];
  const llm = { model: 'm', complete: async (_s: string, u: string) => { asked.push(u); return replies.shift()!; } };
  assert.deepEqual(await designSpec(llm, 'a tip advisor'), tipSpec);
  assert.match(asked[1], /was refused: name must be a lowercase slug/);
  const never = { model: 'm', complete: async () => 'no json here' };
  await assert.rejects(designSpec(never, 'x'), /no JSON object/);
  assert.match(usage(tipSpec), /\*\*service\*\* \(poor, ok, great\), then \*\*party\*\* \(small, large\)\. For example: `great large`/);
});

test('/build is open to members, shows progress, and is rate limited per person', async () => {
  const w = await world();
  const lines: string[] = [];
  (w.pipeline as unknown as { actions: { build: unknown } }).actions.build = async ({ prompt, progress }: { prompt: string; progress: (t: string) => void }) => { progress('Designing your app…'); return `built: ${prompt}`; };
  const build = (text: string) => w.pipeline.handle(ask(text, { command: 'build', trigger: 'slash', authorId: 'maker', status: (t: string) => lines.push(t) }));
  assert.equal((await build('a tip advisor'))?.text, 'built: a tip advisor');
  assert.deepEqual(lines, ['Designing your app…']);
  w.clock.now += 61_000;
  await build('two');
  w.clock.now += 61_000;
  await build('three');
  w.clock.now += 61_000;
  assert.match((await build('four'))!.text, /Rate limited: at most 3 apps an hour/);
});

// The tracker: open questions, promises and requests.
const GUILD = '1342910418754076732';
const msg = (text: string, more: Partial<Observed> = {}): Observed => said(text, { url: `https://discord.com/channels/${GUILD}/c1/${text.length}${more.authorId ?? 'u1'}`, ...more });
async function trackerWorld(guilds: ReadonlySet<string> | null = null) {
  const w = await world();
  const reads: Record<string, { kind: string | null; summary?: string; due?: string | null }> = {
    'Can someone review my PR for the LexLean lexer?': { kind: 'request', summary: 'Asks for a review of a LexLean lexer PR', due: null },
    'How do I pin a holo to IPFS?': { kind: 'question', summary: 'Asks how to pin a holo to IPFS', due: null },
    "I'll send the spec draft by Friday": { kind: 'promise', summary: 'Will send the spec draft', due: '2026-11-27' },
    'Is this cool or what?': { kind: null },
  };
  const asked: string[] = [];
  const llm = { model: 'm', complete: async (_s: string, u: string) => { asked.push(u); if (u.startsWith('Open items:')) return JSON.stringify({ answers: /Filebase/.test(u.slice(u.indexOf('New message: '))) ? [1] : [] }); const text = u.slice(u.indexOf('Message: ') + 9); return JSON.stringify(reads[text] ?? { kind: null }); } };
  const tracker = new Tracker({ kernel, store: w.store, index: w.index, llm, now: () => w.clock.now, guilds });
  return { ...w, tracker, asked };
}

test('the tracker reads only likely messages, and keeps questions, promises and requests, not chatter', async () => {
  assert.ok(candidate('How do I pin a holo to IPFS?'));
  assert.ok(candidate("I'll send the spec draft by Friday"));
  assert.ok(candidate('Can someone review my PR for the LexLean lexer?'));
  assert.ok(!candidate('gm everyone'));
  assert.ok(!candidate('Thanks, that worked great'));
  const w = await trackerWorld();
  assert.equal(await w.tracker.observed(msg('Thanks, that worked great'), 'index'), undefined);
  assert.equal(w.asked.length, 0, 'chatter never reaches the model');
  assert.equal(await w.tracker.observed(msg('Is this cool or what?'), 'index'), undefined);
  for (const text of ['How do I pin a holo to IPFS?', "I'll send the spec draft by Friday", 'Can someone review my PR for the LexLean lexer?']) {
    assert.equal(await w.tracker.observed(msg(text), 'index'), 'tracked');
  }
  // Each message is read with the few before it in the same place, its writer named as such and no one by name.
  assert.match(w.asked.at(-1)!, /Earlier in the same place, oldest first:\n- writer: Thanks, that worked great\n[^]*- writer: How do I pin a holo to IPFS\?\n[^]*\n\nMessage: Can someone review/);
  assert.doesNotMatch(w.asked.at(-1)!, /u1/);
  // A message Q may not keep (a restricted channel, an opted-out author, a request to Q) is never tracked.
  assert.equal(await w.tracker.observed(msg('How do I pin a holo to IPFS? again', { authorId: 'u9' }), 'skip'), undefined);
  const open = await w.tracker.open();
  assert.deepEqual(open.map((i) => i.kind).sort(), ['promise', 'question', 'request']);
  assert.equal(open.find((i) => i.kind === 'promise')!.due, '2026-11-27');
});

test('a reply from someone else answers a question; the asker replying does not; a promise closes only with a check', async () => {
  const w = await trackerWorld();
  const q = msg('How do I pin a holo to IPFS?');
  const p = msg("I'll send the spec draft by Friday");
  await w.tracker.observed(q, 'index');
  await w.tracker.observed(p, 'index');
  // The asker adding detail does not answer their own question.
  assert.equal(await w.tracker.observed(msg('Also with BLAKE3 CIDs', { replyTo: q.url, authorId: 'u1', url: 'https://discord.com/channels/x/c1/r0' }), 'index'), undefined);
  // A bot's reply does not answer it.
  assert.equal(await w.tracker.observed(msg('Beep', { replyTo: q.url, authorId: 'bot', origin: 'bot', url: 'https://discord.com/channels/x/c1/r1' }), 'index'), undefined);
  // Someone else's reply does.
  assert.equal(await w.tracker.observed(msg('Use the Filebase S3 API', { replyTo: q.url, authorId: 'u2', url: 'https://discord.com/channels/x/c1/r2' }), 'index'), 'closed');
  // A reply to a promise does not close it; a check does.
  assert.equal(await w.tracker.observed(msg('Thanks!', { replyTo: p.url, authorId: 'u2', url: 'https://discord.com/channels/x/c1/r3' }), 'index'), undefined);
  assert.equal(await w.tracker.reacted(p.url, '👍', 'u2', true), undefined);
  assert.equal(await w.tracker.reacted(p.url, '✅', 'u2', true), 'closed');
  assert.deepEqual(await w.tracker.open(), []);
});

test('an answer given without a Discord reply closes the question near it; small talk and the asker do not', async () => {
  const w = await trackerWorld();
  const q = msg('How do I pin a holo to IPFS?');
  await w.tracker.observed(q, 'index');
  assert.equal(await w.tracker.observed(msg('Same here, I was wondering too', { authorId: 'u3', url: 'https://discord.com/channels/x/c1/n1', createdMs: q.createdMs + 1 * 60_000 }), 'index'), undefined);
  assert.equal(await w.tracker.observed(msg('Never mind, Filebase works for me', { authorId: 'u1', url: 'https://discord.com/channels/x/c1/n2', createdMs: q.createdMs + 2 * 60_000 }), 'index'), undefined, 'the asker never answers their own question');
  assert.equal(await w.tracker.observed(msg('Elsewhere: use the Filebase S3 API', { authorId: 'u2', channelId: 'c9', url: 'https://discord.com/channels/x/c9/n3', createdMs: q.createdMs + 3 * 60_000 }), 'index'), undefined, 'only in the same place');
  assert.equal(await w.tracker.observed(msg('You can use the Filebase S3 API for that', { authorId: 'u2', url: 'https://discord.com/channels/x/c1/n4', createdMs: q.createdMs + 4 * 60_000 }), 'index'), 'closed');
  assert.deepEqual(await w.tracker.open(), []);
});

test('a deleted message, or a forgotten author, takes the item with it; tracking runs only in the servers it is on for', async () => {
  const w = await trackerWorld();
  const q = msg('How do I pin a holo to IPFS?');
  const r = msg('Can someone review my PR for the LexLean lexer?', { authorId: 'u7' });
  await w.tracker.observed(q, 'index');
  await w.tracker.observed(r, 'index');
  await w.tracker.withdraw(q.url);
  await w.memory.forget({ author: 'u7' });
  assert.deepEqual(await w.tracker.open(), []);
  const elsewhere = await trackerWorld(new Set(['1574440187105251398']));
  assert.equal(await elsewhere.tracker.observed(msg('How do I pin a holo to IPFS?'), 'index'), undefined);
  assert.equal(elsewhere.asked.length, 0);
});

test('/open lists what is open by kind, oldest first, with its link and how old it is, and is for admins only', async () => {
  const w = await trackerWorld();
  await w.tracker.observed(msg('How do I pin a holo to IPFS?', { createdMs: w.clock.now - 3 * 86_400_000 }), 'index');
  await w.tracker.observed(msg("I'll send the spec draft by Friday", { createdMs: w.clock.now }), 'index');
  const text = await w.tracker.summary((url) => `#general (${url.length})`);
  assert.match(text, /^\*\*Open:\*\* 1 question, 1 promise, 0 requests\./);
  assert.match(text, /\*\*Questions\*\*\n- Asks how to pin a holo to IPFS · <@u1> · 3 days · \[#general/);
  assert.match(text, /Will send the spec draft · <@u1> · today · due 2026-11-27/);
  // A server's open items are its own: run in another server, /open shows none of them.
  assert.match(await w.tracker.summary(() => '', 20, GUILD), /^\*\*Open:\*\* 1 question, 1 promise/);
  assert.match(await w.tracker.summary(() => '', 20, '1574440187105251398'), /^Nothing open/);
  assert.equal(await kernel.command('open', 'member'), 'not authorized');
  assert.equal(await kernel.command('open', 'admin'), 'allowed');
});

test('focus candidate prefilter does not tax ordinary questions or accept oversized prompts',()=>{
  assert.equal(possibleFocusQuestion('What is Prism?'),false);
  assert.equal(possibleFocusQuestion('What is the best thing I could work on to advance the UOR Foundation?'),true);
  assert.equal(possibleFocusQuestion('Where can I contribute next?'),true);
  assert.equal(possibleFocusQuestion('What should I work on?'+ 'x'.repeat(4000)),false);
});
test('Discord Focus runs the real entry and model against fresh provider data on repeated questions',async()=>{
  const w=await world();
  const original=w.llm.complete.bind(w.llm);
  let classifications=0,reads=0,n=11;
  w.llm.complete=async(system,user,onText)=>{
    if(system===STRATEGY_ROUTER){classifications++;return '{"intent":"focus"}';}
    return original(system,user,onText);
  };
  w.pipeline.actions.focus=(k,m,q,a,o)=>runFocus(k,m,q,a,{...o,fetcher:async url=>{
    reads++;
    const u=new URL(String(url));
    const repo={name:'q',full_name:'UOR-Foundation/q',private:false,visibility:'public',archived:false,fork:false,default_branch:'main'};
    const issue={number:n,state:'open',title:'@everyone untrusted title',updated_at:'2026-11-25T20:00:00Z',assignees:[],
      repository_url:'https://api.github.com/repos/UOR-Foundation/q',html_url:'https://github.com/UOR-Foundation/q/issues/'+n};
    const body=u.pathname.startsWith('/orgs/')?[repo]:u.pathname==='/search/issues'?{total_count:1,incomplete_results:false,items:[issue]}:u.pathname.endsWith('/dependencies/blocked_by')?[]:u.pathname.endsWith('/issues')?[issue]:issue;
    return new Response(JSON.stringify(body));
  }});
  const question='What should I work on next?';
  const a=await w.pipeline.handle(ask(question));
  n=12;
  const b=await w.pipeline.handle(ask(question));
  assert.match(a!.text,/q#11/);
  assert.match(b!.text,/q#12/);
  assert.doesNotMatch(b!.text,/q#11|@everyone|Answered once before/);
  assert.equal(classifications,2);assert.equal(reads,10);
  assert.equal(w.llm.calls,0);
  assert.equal((await w.store.labels('private')).length,0);
});
test('Discord Focus preserves applicable and unresolved community decisions',async()=>{
  const w=await world();
  w.pipeline.actions.focus=async()=>assert.fail('must not collect');
  const question='What should I work on next about the repository naming rule: is lowercase conformant?';
  const a=await w.pipeline.handle(ask(question));
  assert.match(a!.text,/uor-test-naming → conformant/);
  const original=w.llm.complete.bind(w.llm);
  w.llm.complete=async(system,user,onText)=>{
    if(system.startsWith('You read a question for the inputs'))return '{"app":"unrecognized"}';
    return original(system,user,onText);
  };
  await w.pipeline.handle(ask(question));
});
test('Discord Focus respects ordinary routing, access filters, and non-Discord surfaces',async()=>{
  const w=await world();
  w.pipeline.actions.focus=async()=>assert.fail('must not collect');
  await w.pipeline.handle(ask('What is Prism?'));
  w.pipeline.settings.access={mode:'whitelist',list:new Set()};
  assert.equal(await w.pipeline.handle(ask('What should I work on next?')),undefined);
  w.pipeline.settings.access={mode:'blacklist',list:new Set()};
  w.pipeline.settings.filter={scope:'both',terms:['work']};
  assert.equal((await w.pipeline.handle(ask('What should I work on next?')))?.decision,'interrupt');
  w.pipeline.settings.filter={scope:'both',terms:[]};
  await w.pipeline.handle(ask('What should I work on next?',{surface:'mcp',authorId:'mcp-test'}));
});

test('Discord Focus reports clarification and unavailability without ordinary cached answers',async()=>{
  const w=await world();
  w.pipeline.actions.focus=async()=>({kind:'clarify'});
  assert.match((await w.pipeline.handle(ask('What should I work on next?')))!.text,/Which one public/);
  w.pipeline.actions.focus=async()=>({kind:'unavailable'});
  assert.match((await w.pipeline.handle(ask('What should I work on next?')))!.text,/cannot verify current work/);
  assert.equal(w.llm.calls,0);
  assert.equal((await w.store.labels('private')).length,0);
});

test('capability catalog covers every kernel command and reports actual caller eligibility',async()=>{
  const w=await world();
  assert.deepEqual(Object.keys(DISCORD_COMMANDS).sort(),Object.keys(COMMAND).sort());
  const member=await capabilityReport(kernel,w.decider,w.pipeline.actions,'member');
  assert.ok(matches(member.report,member.label));
  assert.equal(member.report.commands.length,Object.keys(COMMAND).length);
  for(const c of member.report.commands)assert.equal(c.eligibility,(await kernel.command(c.name,'member'))==='allowed'?'eligible':'not authorized');
  assert.equal(member.report.commands.find(c=>c.name==='reindex')?.eligibility,'not authorized');
  assert.equal(member.report.commands.find(c=>c.name==='reindex')?.wiring,'not disclosed');
  assert.equal(member.report.commands.find(c=>c.name==='build')?.wiring,'unavailable');
  const admin=await capabilityReport(kernel,w.decider,w.pipeline.actions,'admin');
  assert.equal(admin.report.commands.find(c=>c.name==='reindex')?.eligibility,'eligible');
  assert.notEqual(admin.label,member.label);
});
test('capability question is direct and private configuration is not consulted',async()=>{
  const w=await world();
  w.pipeline.actions.tools=()=>assert.fail('must not discover tools');
  w.pipeline.actions.build=async()=>assert.fail('must not execute a build');
  const a=await w.pipeline.handle(ask('Show me your full capability map'));
  assert.match(a!.text,/Q capability map/);
  assert.match(a!.text,/\/reindex:.*not authorized/);
  assert.match(a!.text,/DA-39/);
  assert.match(a!.text,/Report blake3:/);
  assert.equal(w.llm.calls,0);
  assert.equal((await w.store.labels('private')).length,0);
  assert.equal(isCapabilityQuestion('what are your capabilities for a naming decision'),false);
});
test('capability report remains subject to Discord access and incoming filters',async()=>{
  const w=await world();
  const question='What can you do?';
  assert.equal(await w.pipeline.handle(ask(question,{channel:{...open,visibility:'restricted'}})),undefined);
  w.pipeline.settings.access={mode:'whitelist',list:new Set()};
  assert.equal(await w.pipeline.handle(ask(question)),undefined);
  w.pipeline.settings.access={mode:'blacklist',list:new Set()};
  w.pipeline.settings.filter={scope:'both',terms:['what']};
  assert.equal((await w.pipeline.handle(ask(question)))?.decision,'interrupt');
  assert.equal(w.llm.calls,0);
});

test('Discord status includes the public capability map without invoking a tool or language model',async()=>{
  const w=await world();
  w.pipeline.actions.tools=()=>assert.fail('must not enumerate private tools');
  const reply=await w.pipeline.handle(ask('',{command:'status',trigger:'slash'}));
  assert.match(reply!.text,/Kernel model/);
  assert.match(reply!.text,/What I can do/);
  assert.equal(w.llm.calls,0);
});

test('capability inventory covers public routes, adapter events and registered claims',async()=>{
  const web=await readFile(new URL('../src/adapter/web.ts',import.meta.url),'utf8');
  const actualWeb=new Set([...web.matchAll(/url\.pathname\s*===\s*'([^']+)'|url\.pathname\.startsWith\('([^']+)'\)|url\.pathname\s*===\s*\x60([^$\x60]+)\$\{/g)].map(m=>m[1]??m[2]??m[3]));
  assert.deepEqual([...actualWeb].sort(),[...WEB_PUBLIC_ROUTES].sort());
  const discord=await readFile(new URL('../src/adapter/discord.ts',import.meta.url),'utf8');
  assert.deepEqual([...discord.matchAll(/client\.(?:on|once)\(Events\.([A-Za-z]+)/g)].map(m=>m[1]).sort(),[...DISCORD_EVENTS].sort());
  const w=await world();
  const member=await capabilityReport(kernel,w.decider,w.pipeline.actions,'member');
  assert.deepEqual(member.report.surfaces.mcp.tools,MCP_PUBLIC_TOOLS.map(t=>t.name));
  const ids=await readFile(new URL('../../model/ids.toml',import.meta.url),'utf8');
  const registered=new Set([...ids.matchAll(/^id = "(DA-\d+)"$/gm)].map(m=>m[1]));
  assert.deepEqual([...new Set([...member.report.commands,...member.report.groups].flatMap(row=>row.policy))].sort(),[...registered].sort());
});
test('capability summary is short, scoped and changes with wiring',async()=>{
  const w=await world();
  const before=await capabilityReport(kernel,w.decider,w.pipeline.actions,'member');
  assert.equal(before.report.groups.find(g=>g.id==='web')?.wiring,'unknown');
  const answer=await w.pipeline.handle(ask('what are you capable of?'));
  assert.match(answer!.text,/What I can do/);
  assert.match(answer!.text,/not enabled here/);
  assert.match(answer!.text,/full capability map/);
  assert.ok(answer!.text.length<1500);
  assert.doesNotMatch(answer!.text,/\/reindex/);
  w.pipeline.actions.capabilityRuntime=()=>({web:true,membership:false,evaluation:true,experiments:false,trackerDigest:true,retention:true});
  const after=await capabilityReport(kernel,w.decider,w.pipeline.actions,'member');
  assert.equal(after.report.groups.find(g=>g.id==='web')?.wiring,'configured');
  assert.equal(after.report.groups.find(g=>g.id==='tracker')?.wiring,'not disclosed');
  assert.notEqual(before.label,after.label);
  assert.ok(matches(after.report,after.label));
  assert.equal(capabilityDetail('What are all of your capabilities?'),'full');
  assert.equal(capabilityDetail('What can you do for me?'),'summary');
  assert.equal(capabilityDetail('what are you capable of?'),'summary');
  assert.equal(capabilityDetail('What is Q capable of?'),'summary');
  assert.equal(capabilityDetail('what are you capable of doing with my private data?'),null);
  assert.equal(capabilityDetail('Describe your capability map.'),'full');
  assert.equal(capabilityDetail('what can you do to change the naming policy'),null);
  assert.equal(w.llm.calls,0);
});
test('capability summary claims an effect only when it is wired',async()=>{
  const w=await world();
  const unwired=summarizeCapabilities(await capabilityReport(kernel,w.decider,w.pipeline.actions,'member'));
  assert.doesNotMatch(unwired,/Receive feedback/);
  assert.match(unwired,/Feedback is not enabled here/);
  w.pipeline.actions.feedback=async()=>'filed';
  const wired=summarizeCapabilities(await capabilityReport(kernel,w.decider,w.pipeline.actions,'member'));
  assert.match(wired,/Receive feedback/);
  assert.match(wired,/\/feedback/);
});
test('capability reports bind only a well-formed measured host fingerprint, never a host revision',async()=>{
  const w=await world();
  const initial=await capabilityReport(kernel,w.decider,w.pipeline.actions,'member');
  assert.equal(initial.report.hostFingerprint,'unavailable');
  w.pipeline.actions.hostFingerprint='sha256:'+'a'.repeat(64);
  const measured=await capabilityReport(kernel,w.decider,w.pipeline.actions,'member');
  assert.equal(measured.report.hostFingerprint,w.pipeline.actions.hostFingerprint);
  assert.equal(measured.report.hostRevision,'not independently established');
  assert.notEqual(initial.label,measured.label);
  const reply=await w.pipeline.handle(ask('what are you capable of now?'));
  assert.match(reply!.text,/Startup package fingerprint: sha256:a{64}/);
  assert.equal(w.llm.calls,0);
  w.pipeline.actions.hostFingerprint='not a public-safe fingerprint';
  const invalid=await capabilityReport(kernel,w.decider,w.pipeline.actions,'member');
  assert.equal(invalid.report.hostFingerprint,'unavailable');
});
test('current capability questions use the live report without broadening action routes',async()=>{
  const cases: [string, 'summary'|'full'|null][] = [["what are you capable of now?","summary"],["What can you do right now?","summary"],["What are your capabilities currently?","summary"],["How can you help me at the moment?","summary"],["Show me your full capability map now!","full"],["What can you do today?","summary"],["What are you capable of doing with my private data now?",null],["What can you do to change the naming policy today?",null],["Show me your full capability map and delete messages now",null],["What were you capable of yesterday?",null]];
  for(const [q, expected] of cases) assert.equal(capabilityDetail(q),expected,q);
  for(const role of ['member','admin'] as const){
    const w=await world();
    w.pipeline.actions.tools=()=>assert.fail('must not enumerate private tools');
    for(const mention of ['<@123>','<@!123>']){
      const reply=await w.pipeline.handle(ask(withoutMention(mention+' what are you capable of now?','123'),{role}));
      assert.match(reply!.text,/What I can do/);
      assert.match(reply!.text,/Report: blake3:[a-f0-9]{64}\./);
    }
    assert.equal(w.llm.calls,0);
  }
});
test('standalone capability phrasings route to the governed report, never to an inferred answer',async()=>{
  for(const q of ['What are you capable of?',"What's Q capable of?",'What\u2019s Q capable of?','What are you able to do?','How can you help me?','What do you do?','WHAT ARE YOU CAPABLE OF?'])
    assert.equal(capabilityDetail(q),'summary',q);
  for(const q of ['How can you help me rename the repository?','What do you do with my messages?',"What's Q capable of deleting?"])
    assert.equal(capabilityDetail(q),null,q);
  const w=await world();
  const reply=await w.pipeline.handle(ask('What\u2019s Q capable of?'));
  assert.match(reply!.text,/What I can do/);
  assert.equal(w.llm.calls,0);
});
