// Wires the parts. Three ways to run:
//   node src/main.ts            serve Discord
//   node src/main.ts ingest     fill the knowledge base from the sources, then exit
//   node src/main.ts backfill   index the history of the public channels, then exit
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { discord } from './adapter/discord.ts';
import { Community, readPolicyDrift } from './community.ts';
import { attested } from './provenance.ts';
import { config } from './config.ts';
import { Kernel } from './kernel.ts';
import { CommunitySource, GitHubSource, WebsiteSource, ingest } from './knowledge.ts';
import { Memory } from './memory.ts';
import { Pipeline } from './pipeline.ts';
import { AnthropicLlm, OpenAiCompatibleEmbedder, OpenAiCompatibleLlm, type Transport } from './providers.ts';
import { loadExperiments, runExperiment, ShadowStore, shadowIndex, type Verdict } from './chaos.ts';
import { Loop } from './improve.ts';
import { communityFiler } from './community-issues.ts';
import { SearchIndex } from './search.ts';
import { Tools } from './tools.ts';
import { mcpServer } from './mcp-server.ts';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { FileStore, KappaRegistryStore } from './store.ts';

const c = config();
const mode = process.argv[2];
// On the MCP surface stdout carries the protocol, so the log goes to stderr.
const out = mode === 'mcp' ? console.error : console.log;
const log = (event: string, fields: Record<string, unknown> = {}) => out(JSON.stringify({ event, ...fields }));

const kernel = await Kernel.open(c.holo);
// The kernel's own provenance, checked as the community's is: these exact bytes must be a build
// this repository's holo workflow signed, from a commit on main.
if (c.kernel.provenance === 'required') {
  await mkdir(dirname(c.kernel.cacheFile), { recursive: true });
  const own = await attested(new Uint8Array(await readFile(c.holo)), { ...c.kernel, githubToken: c.githubToken });
  kernel.commit = own.commit;
  log('kernel-provenance', { holo: kernel.holo, ...own, signer: c.kernel.signer });
} else {
  log('kernel-provenance', { holo: kernel.holo, checked: false, warning: 'KERNEL_PROVENANCE=off: this kernel is not known to be a published build' });
}
const store = c.registryUrl
  ? new KappaRegistryStore(c.registryUrl, c.registryToken, { public: c.registryPublic, private: c.registryPrivate })
  : new FileStore(c.storeDir);
await mkdir(dirname(c.indexFile), { recursive: true });
const index = new SearchIndex(c.indexFile);
const embedder = new OpenAiCompatibleEmbedder(c.embeddingsUrl, c.embeddingsKey, c.embeddingsModel, c.embeddingsPrefix);
const memory = new Memory(kernel, store, index, embedder, c.retentionDays);
log('kernel', { holo: kernel.holo, model: kernel.model, store: c.registryUrl ? 'kappa-registry' : 'folder' });

// The community root: the newest signed community holo, and the one commit it pins.
// Q's read policy is imported from it, so Q refuses to run where the two answer differently.
async function openCommunity(): Promise<Community> {
  const opened = await Community.open({ ...c.community, githubToken: c.githubToken });
  const drift = await readPolicyDrift(kernel, opened);
  if (drift.length) throw new Error(`community refused: Q's read policy differs from uor-discord-read on ${drift.length} of 96 requests: ${drift.slice(0, 3).join('; ')}`);
  log('community', { ...opened.pin, apps: opened.apps.size, skipped: opened.skipped, labels: opened.labels.default, readPolicy: 'agrees on 96 of 96' });
  return opened;
}
let community = await openCommunity();

// Most trusted first. The community is read at the commit its signed holo was built from.
const sources = () => [new CommunitySource(community.pin.commit, community.repository), new WebsiteSource(), new GitHubSource({ token: c.githubToken, only: c.githubRepositories })];
async function reindex(): Promise<string> {
  const lines: string[] = [];
  try {
    community = await openCommunity();
    lines.push(`community pin: ${community.pin.commit.slice(0, 7)}, holo ${community.pin.holo.slice(0, 15)}`);
  } catch (error) {
    log('community-failed', { message: String(error) });
    lines.push(`community pin: kept ${community.pin.commit.slice(0, 7)}, the newest could not be verified`);
  }
  for (const source of sources()) {
    try {
      const result = await ingest(source, kernel, store, index, embedder);
      log('ingested', { source: source.name, ...result });
      lines.push(`${source.name}: ${result.documents} documents, ${result.added} new chunks of ${result.chunks}, ${result.superseded} superseded`);
    } catch (error) {
      log('ingest-failed', { source: source.name, message: String(error) });
      lines.push(`${source.name}: failed, see the log`);
    }
  }
  return lines.join('\n');
}

if (mode === 'ingest') {
  console.log(await reindex());
} else if (mode === 'backfill') {
  await discord(c, (ids) => community.label(ids)).backfill((message) => memory.observe(message));
} else {
  const llm = c.llm.provider === 'anthropic' ? new AnthropicLlm(c.llm.key, c.llm.model, 1024, c.llmConcurrency) : new OpenAiCompatibleLlm(c.llm.url, c.llm.key, c.llm.model, c.llm.thinking, 1024, c.llmConcurrency);
  // Each turn's public event, as one CloudEvents 1.0 JSON line on the log.
  const emit = (e: object) => out(JSON.stringify(e));
  // MCP servers: every tool offered to the language model, every call decided by the kernel.
  const { tools, failed } = await Tools.connect(c.mcpServers);
  log('tools', { servers: c.mcpServers.map((s) => ({ name: s.name, allow: s.allow === true })), tools: tools.list().length, failed });
  const actions: ConstructorParameters<typeof Pipeline>[6] = { memory, reindex, community: () => community, emit, tools: () => tools };
  const pipeline = new Pipeline(kernel, store, index, embedder, llm, c.settings, actions);
  if (mode === 'mcp') {
    // Q's own MCP server on stdio: a client launches this process and talks to it; no port is opened.
    await mcpServer(pipeline, kernel, () => community).connect(new StdioServerTransport());
    log('mcp', { tools: ['ask', 'search', 'status', 'community_apps', 'community_decide'] });
  } else {
    // Chaos experiments, on the production host but never on live traffic: a shadow pipeline over the same
    // model, embedder, index, community and kernel, whose writes stay in memory and whose answers go nowhere.
    const experiments = await loadExperiments(c.chaos.dir);
    log('chaos', { experiments: experiments.map((e) => ({ name: e.experiment.name, label: e.label, approved: community.experiments.has(e.label) })), everyHours: c.chaos.everyHours });
    const failed = (error: unknown) => console.error(JSON.stringify({ event: 'error', message: String(error) }));
    const verdicts = new Map<string, { name: string; result: string; verdict: Verdict }>();
    const shadowing = c.llm.provider === 'openai-compatible';
    const { url, key, model, thinking } = c.llm as { url: string; key: string; model: string; thinking: boolean };
    const shadow = (llmTransport: Transport = fetch, embedderTransport: Transport = fetch, concurrency = 1, settings = pipeline.settings) => {
      const shadowStore = new ShadowStore(store);
      const quietIndex = shadowIndex(index);
      const shadowEmbedder = new OpenAiCompatibleEmbedder(c.embeddingsUrl, c.embeddingsKey, c.embeddingsModel, c.embeddingsPrefix, embedderTransport);
      const shadowLlm = new OpenAiCompatibleLlm(url, key, model, thinking, 1024, concurrency, llmTransport);
      const shadowMemory = new Memory(kernel, shadowStore, quietIndex, shadowEmbedder, c.retentionDays);
      return new Pipeline(kernel, shadowStore, quietIndex, shadowEmbedder, shadowLlm, { ...settings, userLimit: 255, channelLimit: 255, concurrency },
        { memory: shadowMemory, reindex: async () => 'not in a shadow', community: () => community, emit: () => {} });
    };
    if (c.chaos.everyHours > 0 && experiments.length && shadowing) {
      const deps = { kernel, community: () => community, shadow: (l: Transport, e: Transport, n: number) => shadow(l, e, n), load: () => pipeline.load, store, emit: (e: object) => out(JSON.stringify(e)), now: Date.now };
      const tryAll = async () => {
        for (const { experiment } of experiments) {
          const { label, result } = await runExperiment(deps, experiment);
          verdicts.set(result.name, { name: result.name, result: label, verdict: result.verdict });
          log('experiment', { name: result.name, result: label, verdict: result.verdict, reason: result.reason, control: result.control, experimental: result.experimental });
        }
      };
      const tick = () => tryAll().catch(failed);
      setTimeout(() => { tick(); setInterval(tick, c.chaos.everyHours * 3_600_000).unref(); }, c.chaos.firstMinutes * 60_000).unref();
    }

    // The improvement loop (improve.ts): gaps, tests, a daily evaluation, and a review chained to the one before.
    // Questions Q must keep refusing: no evolution may buy answers by loosening grounding.
    const probes = [...new Map(experiments.flatMap((e) => e.experiment.questions).filter((q) => q.expect === 'refused').map((q) => [q.text, q])).values()];
    const loop = new Loop({
      kernel, store, index, embedder, community: () => community, shadow: (settings) => shadow(fetch, fetch, 1, settings), load: () => pipeline.load,
      settings: () => pipeline.settings, adopt: (genes) => { pipeline.settings = { ...pipeline.settings, ...genes }; log('genome', { adopted: genes }); },
      experiments: () => [...verdicts.values()], probes, emit, now: Date.now,
      evaluation: { size: c.loop.evaluationSize, maxErrorPct: c.loop.maxErrorPct, maxP95Seconds: c.loop.maxP95Seconds },
      requests: { threshold: c.requests.threshold, file: c.requests.token ? (r) => communityFiler({ repository: community.repository, token: c.requests.token })(r) : undefined },
    });
    actions.improve = () => loop.summary();
    actions.feedback = (f) => loop.feedback(f);
    log('requests', { threshold: c.requests.threshold, filing: c.requests.token ? community.repository : 'off: no COMMUNITY_ISSUES_TOKEN' });
    log('genome', { label: await loop.restore(), genes: { mediumSimilarity: pipeline.settings.mediumSimilarity, highSimilarity: pipeline.settings.highSimilarity, retrieve: pipeline.settings.retrieve } });
    if (c.loop.everyHours > 0 && shadowing) {
      const turn = () => loop.daily().then(({ label, review, evolution }) => log('review', { label, self: review.self, gaps: review.gaps, tests: review.tests, evolution: evolution?.decision ?? 'not tried', proposals: review.proposals.length })).catch(failed);
      setTimeout(() => { turn(); setInterval(turn, c.loop.everyHours * 3_600_000).unref(); }, c.loop.firstMinutes * 60_000).unref();
    }

    const sweep = async () => log('retention', { removed: await memory.sweep() });
    await sweep();
    setInterval(sweep, 86_400_000).unref();
    const adapter = discord(c, (ids) => community.label(ids));
    actions.channelName = (id) => adapter.channelName?.(id);
    await adapter.start({
      handle: (message) => pipeline.handle(message),
      observe: async (message) => {
        const decision = await memory.observe(message);
        await loop.observed(message, decision).catch(failed);
        return decision;
      },
      delivered: (d) => loop.delivered(d),
      approve: (url, emoji, human) => (emoji === '👎' ? loop.disapproved(url, human).then(() => 'skip' as const) : loop.approved(url, emoji, human)),
      withdraw: (url, before) => memory.withdraw(url, before),
      forgetChannel: (id) => memory.forget({ channel: id }),
      membership: (onRules, human, added) => kernel.membership(onRules, human, added),
    });
  }
}
