// Configuration from the environment. Secrets are read here and nowhere else,
// and never logged.
import type { ServerConfig } from './tools.ts';

const need = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`missing environment variable ${name}`);
  return value;
};
const list = (name: string) => (process.env[name] ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/** The rules message, from its link (https://discord.com/channels/guild/channel/message), with its role and emoji. */
function rules(link: string | undefined, role: string | undefined, emoji: string) {
  if (!link || !role) return null;
  const match = /channels\/(\d+)\/(\d+)\/(\d+)$/.exec(link.trim());
  if (!match) throw new Error('RULES_MESSAGE must be a message link: https://discord.com/channels/<guild>/<channel>/<message>');
  return { guild: match[1], channel: match[2], message: match[3], role, emoji };
}
const number = (name: string, fallback: number) => (process.env[name] ? Number(process.env[name]) : fallback);
function choice<T extends string>(name: string, values: readonly T[], fallback: T): T {
  const value = process.env[name] || fallback;
  if (!values.includes(value as T)) throw new Error(`${name} must be one of ${values.join(', ')}`);
  return value as T;
}

export function config() {
  const provider = process.env.LLM_PROVIDER ?? 'anthropic';
  const c = {
    holo: process.env.KERNEL_HOLO ?? '../app/.prism/build/q.holo',
    // The kernel runs only when its exact bytes are ones this repository's holo workflow signed.
    // off is for developing an unpublished model on one machine, never for a deployment.
    kernel: {
      provenance: choice('KERNEL_PROVENANCE', ['required', 'off'] as const, 'required'),
      repository: process.env.KERNEL_REPOSITORY ?? 'UOR-Foundation/q',
      signer: process.env.KERNEL_SIGNER ?? 'https://github.com/UOR-Foundation/q/.github/workflows/holo.yml@refs/heads/main',
      cacheFile: process.env.KERNEL_PROVENANCE_FILE ?? './data/kernel.provenance.json',
    },
    discordToken: need('DISCORD_TOKEN'),
    installedByAdmin: process.env.INSTALLED_BY_ADMIN === 'true',
    messageContentIntent: process.env.MESSAGE_CONTENT_INTENT === 'true',
    adminRoles: new Set(list('ADMIN_ROLES')),
    // The rules message members confirm by reacting (its link), and the role confirming gives. Unset: Q changes no role.
    membership: rules(process.env.RULES_MESSAGE, process.env.MEMBER_ROLE, process.env.RULES_EMOJI ?? '✅'),
    llm: provider === 'anthropic'
      ? { provider: 'anthropic' as const, key: need('ANTHROPIC_API_KEY'), model: process.env.ANTHROPIC_MODEL ?? 'claude-opus-5-5' }
      // Ollama speaks the same chat completions route, on its own port, with no key.
      : provider === 'ollama'
        ? { provider: 'openai-compatible' as const, url: process.env.LLM_URL ?? 'http://localhost:11434/v1', key: '', model: need('LLM_MODEL'), thinking: process.env.LLM_THINKING !== 'false' }
        : { provider: 'openai-compatible' as const, url: need('LLM_URL'), key: process.env.LLM_API_KEY ?? '', model: need('LLM_MODEL'), thinking: process.env.LLM_THINKING !== 'false' },
    // MCP servers, as JSON: [{"name": "lexlean", "url": "https://...", "allow": true}] or {"command": ..., "args": [...]}.
    mcpServers: JSON.parse(process.env.MCP_SERVERS || '[]') as ServerConfig[],
    // Model calls at once. A provider's plan caps concurrent requests; past the cap it refuses them.
    llmConcurrency: number('LLM_CONCURRENCY', 2),
    // LangBot's message aggregator: messages from one person in one channel this close together are one question.
    aggregateMs: number('AGGREGATE_MS', 1500),
    // Chaos experiments (chaos.ts): where they are, and how often each approved one is tried. 0 hours: never.
    chaos: { dir: process.env.CHAOS_DIR ?? '../experiments', everyHours: number('CHAOS_EVERY_HOURS', 24), firstMinutes: number('CHAOS_FIRST_MINUTES', 10) },
    // The improvement loop (improve.ts): how often it measures and reviews, how many tests a day, and the bounds.
    // Members' requests (/feedback): how many must ask before one is filed, and a token that may open issues in the
    // community repository. Without the token, requests are kept and wait.
    requests: { threshold: number('REQUEST_THRESHOLD', 2), token: process.env.COMMUNITY_ISSUES_TOKEN ?? '' },
    loop: { everyHours: number('LOOP_EVERY_HOURS', 24), firstMinutes: number('LOOP_FIRST_MINUTES', 20), evaluationSize: number('LOOP_EVALUATION_SIZE', 12), maxErrorPct: number('LOOP_MAX_ERROR_PCT', 10), maxP95Seconds: number('LOOP_MAX_P95_SECONDS', 60), minClass: number('LOOP_MIN_CLASS', 10), maxRefusedPct: number('LOOP_MAX_REFUSED_PCT', 50), maxWrongPct: number('LOOP_MAX_WRONG_PCT', 20) },
    embeddingsUrl: need('EMBEDDINGS_URL'),
    embeddingsKey: process.env.EMBEDDINGS_API_KEY ?? '',
    embeddingsModel: need('EMBEDDINGS_MODEL'),
    // nomic-embed-text wants these; most other models want none.
    embeddingsPrefix: { query: process.env.EMBEDDINGS_QUERY_PREFIX ?? '', document: process.env.EMBEDDINGS_DOCUMENT_PREFIX ?? '' },
    registryUrl: process.env.KAPPA_REGISTRY_URL,
    registryToken: process.env.KAPPA_REGISTRY_TOKEN ?? '',
    registryPublic: process.env.KAPPA_NAMESPACE_PUBLIC ?? 'uor-agent/public',
    registryPrivate: process.env.KAPPA_NAMESPACE_PRIVATE ?? 'uor-agent/private',
    storeDir: process.env.STORE_DIR ?? './data/store',
    indexFile: process.env.INDEX_FILE ?? './data/index.sqlite',
    backfillFile: process.env.BACKFILL_FILE ?? './data/backfill.json',
    // The community root. The commit is not configured: it is read from the holo's signed provenance.
    community: {
      repository: process.env.COMMUNITY_REPOSITORY ?? 'UOR-Foundation/community',
      holoUrl: process.env.COMMUNITY_HOLO_URL ?? 'https://uor-foundation.github.io/community/app.holo',
      signer: process.env.COMMUNITY_SIGNER ?? 'https://github.com/UOR-Foundation/community/.github/workflows/pages.yml@refs/heads/main',
      cacheDir: process.env.COMMUNITY_CACHE_DIR ?? './data/community',
    },
    // The website's adapter. No port means no web surface: nothing listens unless an operator names one.
    web: {
      port: number('WEB_PORT', 0),
      host: process.env.WEB_HOST ?? '127.0.0.1',
      origins: process.env.WEB_ORIGINS ? list('WEB_ORIGINS') : ['https://uor.foundation'],
      suggestionsFile: process.env.WEB_SUGGESTIONS ?? './web/suggestions.json',
      concurrency: number('WEB_CONCURRENCY', 1),
      trustProxy: process.env.WEB_TRUST_PROXY === 'true',
    },
    githubToken: process.env.GITHUB_TOKEN ?? '',
    githubRepositories: list('GITHUB_REPOSITORIES'),
    retentionDays: number('RETENTION_DAYS', 180),
    settings: {
      userLimit: number('RATE_USER_LIMIT', 5),
      channelLimit: number('RATE_CHANNEL_LIMIT', 20),
      windowMs: number('RATE_WINDOW_SECONDS', 60) * 1000,
      mediumSimilarity: number('SIMILARITY_MEDIUM', 0.35),
      highSimilarity: number('SIMILARITY_HIGH', 0.5),
      retrieve: number('RETRIEVE', 6),
      // The answer shape the prompt starts from (pipeline.ts STYLES); the loop may evolve it.
      style: number('PROMPT_STYLE', 0),
      // LangBot's pipeline settings.
      access: { mode: choice('ACCESS_MODE', ['blacklist', 'whitelist'] as const, 'blacklist'), list: new Set(list('ACCESS_LIST')) },
      filter: { scope: choice('FILTER_SCOPE', ['both', 'incoming', 'outgoing'] as const, 'both'), terms: list('FILTER_TERMS') },
      longText: choice('LONG_TEXT', ['split', 'file'] as const, 'split'),
      concurrency: number('CONCURRENCY', 4),
      historyMinutes: number('HISTORY_MINUTES', 30),
    },
  };
  // A limit is one byte in a kernel request, and an age past 255 days is sent as 255,
  // so the retention limit stops at 254 for an older item still to be past it.
  const whole = (value: number, greatest: number, name: string) => {
    if (!Number.isInteger(value) || value < 1 || value > greatest) throw new Error(`${name} must be a whole number from 1 to ${greatest}`);
  };
  whole(c.settings.userLimit, 255, 'RATE_USER_LIMIT');
  whole(c.settings.channelLimit, 255, 'RATE_CHANNEL_LIMIT');
  whole(c.retentionDays, 254, 'RETENTION_DAYS');
  whole(c.settings.concurrency, 64, 'CONCURRENCY');
  whole(c.llmConcurrency, 64, 'LLM_CONCURRENCY');
  whole(c.web.concurrency, 64, 'WEB_CONCURRENCY');
  if (!Number.isInteger(c.web.port) || c.web.port < 0 || c.web.port > 65535) throw new Error('WEB_PORT must be a port number, or 0 for no web surface');
  return c;
}
export type Config = ReturnType<typeof config>;
