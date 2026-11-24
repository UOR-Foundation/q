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
import { AnthropicLlm, OpenAiCompatibleEmbedder, OpenAiCompatibleLlm } from './providers.ts';
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
  const pipeline = new Pipeline(kernel, store, index, embedder, llm, c.settings, { memory, reindex, community: () => community, emit, tools: () => tools });
  if (mode === 'mcp') {
    // Q's own MCP server on stdio: a client launches this process and talks to it; no port is opened.
    await mcpServer(pipeline, kernel, () => community).connect(new StdioServerTransport());
    log('mcp', { tools: ['ask', 'search', 'status', 'community_apps', 'community_decide'] });
  } else {
    const sweep = async () => log('retention', { removed: await memory.sweep() });
    await sweep();
    setInterval(sweep, 86_400_000).unref();
    await discord(c, (ids) => community.label(ids)).start({
      handle: (message) => pipeline.handle(message),
      observe: (message) => memory.observe(message),
      withdraw: (url, before) => memory.withdraw(url, before),
      forgetChannel: (id) => memory.forget({ channel: id }),
    });
  }
}
