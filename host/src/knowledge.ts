// Knowledge sources and ingestion. A source yields documents; ingestion stores
// each as a snapshot and its chunks, by label, in the namespace the kernel names.
import type { Kernel, Level, SourceName } from './kernel.ts';
import type { Embedder } from './providers.ts';
import type { SearchIndex } from './search.ts';
import type { Store } from './store.ts';

export interface Document { url: string; text: string; /** When one document differs from its source's level: an issue is conversation. */ level?: Level }

export interface Source {
  readonly name: SourceName;
  /** What a claim retrieved from this source is: reproduced from an authority, or only measured. */
  readonly level: Level;
  documents(): AsyncIterable<Document>;
}

const get = async (url: string, headers: Record<string, string> = {}) => {
  const response = await fetch(url, { headers: { 'user-agent': 'uor-discord-agent', ...headers } });
  if (!response.ok) throw new Error(`fetch ${url}: ${response.status}`);
  return response.text();
};

/** uor.foundation, from its own map for agents: /llms.txt, then the Markdown twin of every page it lists. */
export class WebsiteSource implements Source {
  readonly name = 'website';
  readonly level = 'some-true';
  origin: string;
  constructor(origin = 'https://uor.foundation') {
    this.origin = origin;
  }
  async *documents() {
    const map = await get(`${this.origin}/llms.txt`);
    yield { url: `${this.origin}/llms.txt`, text: map };
    const seen = new Set<string>();
    for (const [, link] of map.matchAll(/\]\(([^)\s]+)\)/g)) {
      const url = new URL(link, this.origin);
      if (url.origin !== this.origin) continue;
      if (!/\.(md|txt)$/.test(url.pathname)) url.pathname = url.pathname.replace(/\/$/, '') + '.md';
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      try {
        yield { url: url.href, text: await get(url.href) };
      } catch {
        // A page the map lists and the site does not serve is skipped, not invented.
      }
    }
  }
}

/** UOR-Foundation/community at one pinned commit: the decision apps and the documents that state the model. */
export class CommunitySource implements Source {
  readonly name = 'community';
  readonly level = 'some-true';
  commit: string;
  repository: string;
  constructor(commit: string, repository = 'UOR-Foundation/community') {
    this.commit = commit;
    this.repository = repository;
  }
  async *documents() {
    const tree = JSON.parse(await get(`https://api.github.com/repos/${this.repository}/git/trees/${this.commit}?recursive=1`)) as { tree: { path: string; type: string }[] };
    const wanted = (path: string) => /^apps\/[^/]+\.prompt\.json$/.test(path) || ['README.md', 'AGENTS.md', 'CONFORMANCE.md'].includes(path) || /^docs\/decisions\/[^/]+\.md$/.test(path);
    for (const entry of tree.tree) {
      if (entry.type !== 'blob' || !wanted(entry.path)) continue;
      const url = `https://github.com/${this.repository}/blob/${this.commit}/${entry.path}`;
      yield { url, text: await get(`https://raw.githubusercontent.com/${this.repository}/${this.commit}/${entry.path}`) };
    }
  }
}

/**
 * Every public repository of the organization, each at the commit its default branch is on now:
 * the Markdown at its root and under docs/, and its issues and pull requests.
 * Needs a token for more than a few repositories: the unauthenticated limit is 60 requests an hour.
 */
export class GitHubSource implements Source {
  readonly name = 'github';
  readonly level = 'some-true';
  organization: string;
  #token: string;
  only: string[];
  skip: string[];
  constructor(options: { organization?: string; token?: string; only?: string[]; skip?: string[] } = {}) {
    this.organization = options.organization ?? 'UOR-Foundation';
    this.#token = options.token ?? '';
    this.only = options.only ?? [];
    // The community model is its own, more trusted source.
    this.skip = options.skip ?? ['community'];
  }
  #api(path: string, accept = 'application/vnd.github+json') {
    return get(`https://api.github.com${path}`, { accept, ...(this.#token ? { authorization: `Bearer ${this.#token}` } : {}) });
  }
  async *documents() {
    const repositories = JSON.parse(await this.#api(`/orgs/${this.organization}/repos?type=public&per_page=100`)) as { name: string; full_name: string; default_branch: string; archived: boolean; fork: boolean }[];
    for (const repository of repositories) {
      if (repository.archived || repository.fork || this.skip.includes(repository.name)) continue;
      if (this.only.length && !this.only.includes(repository.name)) continue;
      const commit = (await this.#api(`/repos/${repository.full_name}/commits/${repository.default_branch}`, 'application/vnd.github.sha')).trim();
      const tree = JSON.parse(await this.#api(`/repos/${repository.full_name}/git/trees/${commit}?recursive=1`)) as { tree: { path: string; type: string; size?: number }[] };
      const files = tree.tree.filter((entry) => entry.type === 'blob' && (entry.size ?? 0) < 200_000 && /^([^/]+|docs\/.+)\.md$/i.test(entry.path)).slice(0, 60);
      for (const file of files) {
        yield { url: `https://github.com/${repository.full_name}/blob/${commit}/${file.path}`, text: await get(`https://raw.githubusercontent.com/${repository.full_name}/${commit}/${file.path}`) };
      }
      const issues = JSON.parse(await this.#api(`/repos/${repository.full_name}/issues?state=all&per_page=50`)) as { html_url: string; title: string; body: string | null; state: string }[];
      for (const issue of issues) {
        yield { url: issue.html_url, text: `# ${issue.title}

State: ${issue.state}

${issue.body ?? ''}`, level: 'open' as const };
      }
    }
  }
}

/** Split on blank lines and pack paragraphs up to the size, so a chunk ends where the author paused. */
export function chunks(text: string, size = 1200): string[] {
  const out: string[] = [];
  let current = '';
  for (const paragraph of text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)) {
    if (current && current.length + paragraph.length + 2 > size) { out.push(current); current = ''; }
    if (paragraph.length > size) {
      for (let i = 0; i < paragraph.length; i += size) out.push(paragraph.slice(i, i + size));
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) out.push(current);
  return out;
}

export interface Ingested { documents: number; chunks: number; added: number; superseded: number }

export async function ingest(source: Source, kernel: Kernel, store: Store, index: SearchIndex, embedder: Embedder): Promise<Ingested> {
  const namespace = await kernel.namespace(source.name);
  const result = { documents: 0, chunks: 0, added: 0, superseded: 0 };
  const seen = new Set<string>();
  for await (const document of source.documents()) {
    result.documents++;
    const snapshot = await store.put(namespace, { type: 'snapshot', source: source.name, url: document.url, text: document.text });
    const parts = chunks(document.text);
    for (let position = 0; position < parts.length; position++) {
      result.chunks++;
      const label = await store.put(namespace, { type: 'chunk', source: source.name, level: document.level ?? source.level, url: document.url, snapshot, position, text: parts[position] });
      seen.add(label);
      // An unchanged chunk has an unchanged label: it is neither embedded nor linked again.
      if (index.has(label)) continue;
      await store.link(namespace, { source: label, target: snapshot, relation: 'section-of' });
      const [vector] = await embedder.embed([parts[position]]);
      index.add(label, namespace, parts[position], vector);
      result.added++;
    }
  }
  // A complete run is the source as it is now. A chunk of it this run did not produce (a page gone, a
  // repository at a newer commit) is superseded: it leaves the index and is revoked, and the store keeps it
  // as the record of what was. Rebuilding the index skips it too, so a rebuild still equals the index.
  for (const label of index.labels(namespace)) {
    if (seen.has(label)) continue;
    const item = await store.get(namespace, label);
    if (item?.type !== 'chunk' || item.source !== source.name) continue;
    index.remove(label);
    const revocation = await store.put(namespace, { type: 'revocation', target: label, reason: 'superseded' });
    await store.link(namespace, { source: revocation, target: label, relation: 'revocation' });
    result.superseded++;
  }
  return result;
}
