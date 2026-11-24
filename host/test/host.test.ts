// Host tests. The kernel is the real holo; the store, the embedder and the
// language model are in-process fakes, so nothing here reaches the network.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { before, test } from 'node:test';
import { isLabel, labelOf, matches } from '../src/address.ts';
import { channelLabels, readPolicyDrift, type Decider, type DecisionApp } from '../src/community.ts';
import { Kernel, type ChannelFacts } from '../src/kernel.ts';
import { chunks, ingest, type Source } from '../src/knowledge.ts';
import { Memory, type Observed } from '../src/memory.ts';
import { Pipeline, type Incoming, type Settings } from '../src/pipeline.ts';
import { ANSWER_SCHEMA, CONTEXT_SCHEMA, type CloudEvent } from '../src/records.ts';
import { Gate, retrying, withoutReasoning, type Embedder, type Llm, type RunTool, type ToolCall, type ToolSpec } from '../src/providers.ts';
import { Tools } from '../src/tools.ts';
import { payloads } from '../src/adapter/adapter.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { SearchIndex } from '../src/search.ts';
import { FileStore, isRevoked, MemoryStore } from '../src/store.ts';

const HOLO = new URL('../../app/.prism/build/uor-discord-agent.holo', import.meta.url);

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
  async complete(system: string, user: string) {
    // The decision reader: it gives the case only when the question states it.
    if (system.startsWith('You read a question for the inputs')) {
      const question = user.slice(user.lastIndexOf('Question:'));
      // Like a real model: the naming app only for a question about naming.
      if (!/naming/.test(question)) return JSON.stringify({ app: null });
      return JSON.stringify({ app: 'uor-test-naming', inputs: /lowercase/.test(question) ? { case: 'lowercase' } : {} });
    }
    this.calls++;
    return this.answer ?? `Answer drawn from ${(user.match(/^\[\d+\]/gm) ?? []).length} sources [1].`;
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
  userLimit: 3, channelLimit: 20, windowMs: 60_000, mediumSimilarity: 0.35, highSimilarity: 0.5, retrieve: 4,
  access: { mode: 'blacklist', list: new Set() }, filter: { scope: 'both', terms: [] }, longText: 'split', concurrency: 4,
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
  assert.match(reply.text, /^-# \[1\] <https:\/\/example\.test\/community\/discord-read>/m);
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

test('the retention sweep deletes what is past its limit and keeps what is at it', async () => {
  const { memory, clock, index } = await world();
  const day = 86_400_000;
  await memory.observe(said('thirty one days old message', { createdMs: clock.now - 31 * day }));
  await memory.observe(said('exactly thirty days old', { createdMs: clock.now - 30 * day }));
  await memory.observe(said('four hundred days old, past one byte', { createdMs: clock.now - 400 * day }));
  const count = index.count();
  assert.equal(await memory.sweep(), 2);
  assert.equal(index.count(), count - 2);
  assert.equal(await memory.sweep(), 0);
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
