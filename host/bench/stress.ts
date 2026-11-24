// Stress run: the real pipeline, model, embeddings, index and community holo, over a fixed
// question set, without Discord. Each question is asked one at a time for clean latency, then
// the grounded ones all at once for the query pool. Prints one JSON line per answer, then a summary.
//
//   node --no-warnings bench/stress.ts bench/questions.json
//
// Run it against a copy of the data: every turn writes its records to the store it is given.
import { readFile } from 'node:fs/promises';
import { Community } from '../src/community.ts';
import { config } from '../src/config.ts';
import { Kernel } from '../src/kernel.ts';
import { Memory } from '../src/memory.ts';
import { Pipeline, type Incoming, type Outgoing } from '../src/pipeline.ts';
import { AnthropicLlm, OpenAiCompatibleEmbedder, OpenAiCompatibleLlm } from '../src/providers.ts';
import { SearchIndex } from '../src/search.ts';
import { FileStore } from '../src/store.ts';

interface Question { id: string; kind: string; text: string; repeat?: number; expect: string }

const c = config();
const questions = JSON.parse(await readFile(process.argv[2] ?? 'bench/questions.json', 'utf8')) as Question[];
const kernel = await Kernel.open(c.holo);
const store = new FileStore(c.storeDir);
const index = new SearchIndex(c.indexFile);
const embedder = new OpenAiCompatibleEmbedder(c.embeddingsUrl, c.embeddingsKey, c.embeddingsModel, c.embeddingsPrefix);
const llm = c.llm.provider === 'anthropic' ? new AnthropicLlm(c.llm.key, c.llm.model, 1024, c.llmConcurrency) : new OpenAiCompatibleLlm(c.llm.url, c.llm.key, c.llm.model, c.llm.thinking, 1024, c.llmConcurrency);
const community = await Community.open({ ...c.community, githubToken: c.githubToken });
const memory = new Memory(kernel, store, index, embedder, c.retentionDays);
const settings = { ...c.settings, userLimit: 255, channelLimit: 255, concurrency: Number(process.env.CONCURRENCY ?? c.settings.concurrency) };
const pipeline = new Pipeline(kernel, store, index, embedder, llm, settings, { memory, reindex: async () => '', community: () => community, emit: () => {} });

const ask = (q: Question, author: string): Incoming => ({
  channel: { kind: 'text', visibility: 'everyone', label: 'public', install: 'admin', intent: 'granted' },
  channelId: 'stress', authorId: author, role: 'member', trigger: 'mention',
  text: q.repeat ? q.text.repeat(q.repeat).trim() : q.text,
});

async function run(q: Question, author: string) {
  const started = performance.now();
  let reply: Outgoing | undefined;
  let error: string | undefined;
  try {
    reply = await pipeline.handle(ask(q, author));
  } catch (e) {
    error = String(e);
  }
  const ms = Math.round(performance.now() - started);
  return { id: q.id, kind: q.kind, ms, decision: reply?.decision ?? (error ? 'error' : 'silent'), delivery: reply?.delivery, timings: reply?.timings, chars: reply?.text.length, error, expect: q.expect, text: reply?.text };
}

const sequential: Awaited<ReturnType<typeof run>>[] = [];
for (const q of questions) {
  const result = await run(q, `stress-${q.id}`);
  sequential.push(result);
  console.log(JSON.stringify(result));
}

const burst = questions.filter((q) => q.kind === 'grounded');
const burstStarted = performance.now();
// Reworded, so each is a new answer key: the burst measures the model gate, not the memo.
const parallel = await Promise.all(burst.map((q) => run({ ...q, text: `In short: ${q.text}` }, `burst-${q.id}`)));
const burstMs = Math.round(performance.now() - burstStarted);
for (const r of parallel) console.log(JSON.stringify({ burst: true, id: r.id, ms: r.ms, decision: r.decision, error: r.error?.slice(0, 300) }));

const answered = sequential.filter((r) => r.timings?.answer !== undefined);
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
const stage = (name: string) => median(answered.map((r) => r.timings?.[name] ?? 0));
console.log(JSON.stringify({
  summary: true,
  questions: sequential.length,
  errors: sequential.filter((r) => r.error).map((r) => `${r.id}: ${r.error}`),
  outcomes: Object.fromEntries([...new Set(sequential.map((r) => r.decision))].map((d) => [d, sequential.filter((r) => r.decision === d).map((r) => r.id)])),
  medianMs: { total: median(answered.map((r) => r.ms)), embed: stage('embed'), search: stage('search'), cite: stage('cite'), ground: stage('ground'), decision: stage('decision'), answer: stage('answer'), record: stage('record') },
  burst: { questions: burst.length, concurrency: settings.concurrency, wallMs: burstMs, slowestMs: Math.max(...parallel.map((r) => r.ms)), errors: parallel.filter((r) => r.error).length },
}));
