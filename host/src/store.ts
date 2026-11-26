// The store of record: items by kappa label, and typed edges between labels.
// The relation names are the Kappa Registry's own.
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { type Item, labelOf } from './address.ts';

export type Namespace = 'public' | 'private';
export type Relation = 'section-of' | 'derived-from' | 'evidence-provenance' | 'refers-to' | 'certified-by' | 'revocation';
export interface Edge { source: string; target: string; relation: Relation }

export interface Store {
  /** Store the item under its label and return the label. Storing the same item twice is one item. */
  put(namespace: Namespace, item: Item): Promise<string>;
  get(namespace: Namespace, label: string): Promise<Item | undefined>;
  has(namespace: Namespace, label: string): Promise<boolean>;
  link(namespace: Namespace, edge: Edge): Promise<void>;
  /** Edges whose target is the label. */
  edgesTo(namespace: Namespace, label: string): Promise<Edge[]>;
  /** Remove the item's bytes. Its edges stay, so a revocation still names it. */
  delete(namespace: Namespace, label: string): Promise<void>;
  labels(namespace: Namespace): Promise<string[]>;
  /** A record a crash left half-written still holds content: stores that can tear say so instead of reporting it absent. */
  inspect?(namespace: Namespace, label: string): Promise<{ state: 'ok'; item: Item } | { state: 'missing' } | { state: 'torn'; bytes: string }>;
  /** Set by the memory while a forget runs: a write it refuses is not stored, whoever the writer is. */
  admits?: (namespace: Namespace, item: Item) => boolean;
}

/** The label a store's put returns, after the instance's admission; a refused write stores nothing. */
async function admitted(store: Store, namespace: Namespace, item: Item, write: () => Promise<void>): Promise<string> {
  if (!store.admits || store.admits(namespace, item)) await write();
  return labelOf(item);
}

export const isRevoked = async (store: Store, namespace: Namespace, label: string) =>
  (await store.edgesTo(namespace, label)).some((edge) => edge.relation === 'revocation');

export class MemoryStore implements Store {
  items = { public: new Map<string, string>(), private: new Map<string, string>() };
  edges = { public: [] as Edge[], private: [] as Edge[] };

  admits?: (namespace: Namespace, item: Item) => boolean;
  async put(namespace: Namespace, item: Item) {
    return admitted(this, namespace, item, async () => { this.items[namespace].set(labelOf(item), JSON.stringify(item)); });
  }
  async get(namespace: Namespace, label: string) {
    const bytes = this.items[namespace].get(label);
    return bytes === undefined ? undefined : (JSON.parse(bytes) as Item);
  }
  async has(namespace: Namespace, label: string) {
    return this.items[namespace].has(label);
  }
  async link(namespace: Namespace, edge: Edge) {
    this.edges[namespace].push(edge);
  }
  async edgesTo(namespace: Namespace, label: string) {
    return this.edges[namespace].filter((edge) => edge.target === label);
  }
  async delete(namespace: Namespace, label: string) {
    this.items[namespace].delete(label);
  }
  async labels(namespace: Namespace) {
    return [...this.items[namespace].keys()];
  }
}

/** A folder: one file per item, named by its label, and one edge per line. For running without a registry. */
export class FileStore implements Store {
  root: string;
  constructor(root: string) {
    this.root = root;
  }
  #file = (namespace: Namespace, label: string) => join(this.root, namespace, 'items', label.replace(':', '-') + '.json');
  #edges = (namespace: Namespace) => join(this.root, namespace, 'edges.jsonl');

  admits?: (namespace: Namespace, item: Item) => boolean;
  /** Written whole or not at all: a temporary file, synced, then renamed over the label's name. */
  async put(namespace: Namespace, item: Item) {
    return admitted(this, namespace, item, async () => {
      const label = labelOf(item);
      await mkdir(join(this.root, namespace, 'items'), { recursive: true });
      const file = this.#file(namespace, label);
      const temporary = `${file}.${randomUUID()}.tmp`;
      const handle = await open(temporary, 'w');
      try {
        await handle.writeFile(JSON.stringify(item));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, file);
    });
  }
  async inspect(namespace: Namespace, label: string) {
    let bytes: string;
    try { bytes = await readFile(this.#file(namespace, label), 'utf8'); } catch { return { state: 'missing' as const }; }
    try { return { state: 'ok' as const, item: JSON.parse(bytes) as Item }; } catch { return { state: 'torn' as const, bytes }; }
  }
  async get(namespace: Namespace, label: string) {
    try {
      return JSON.parse(await readFile(this.#file(namespace, label), 'utf8')) as Item;
    } catch {
      return undefined;
    }
  }
  async has(namespace: Namespace, label: string) {
    return (await this.get(namespace, label)) !== undefined;
  }
  async link(namespace: Namespace, edge: Edge) {
    await mkdir(join(this.root, namespace), { recursive: true });
    await appendFile(this.#edges(namespace), JSON.stringify(edge) + '\n');
  }
  /**
   * Edges by target, read once. The edge file only grows, so each call reads only what was appended since,
   * by this process or another (an ingest run's revocations), instead of the whole file every time.
   */
  #seen = new Map<Namespace, { offset: number; byTarget: Map<string, Edge[]> }>();
  async edgesTo(namespace: Namespace, label: string) {
    let size: number;
    try {
      size = (await stat(this.#edges(namespace))).size;
    } catch {
      return [];
    }
    let seen = this.#seen.get(namespace);
    if (!seen || size < seen.offset) this.#seen.set(namespace, (seen = { offset: 0, byTarget: new Map() }));
    if (size > seen.offset) {
      const file = await open(this.#edges(namespace), 'r');
      try {
        const buffer = Buffer.alloc(size - seen.offset);
        await file.read(buffer, 0, buffer.length, seen.offset);
        // Only whole lines: a line still being appended is read on a later call.
        const text = buffer.toString('utf8');
        const complete = text.lastIndexOf('\n') + 1;
        for (const line of text.slice(0, complete).split('\n').filter(Boolean)) {
          const edge = JSON.parse(line) as Edge;
          const list = seen.byTarget.get(edge.target);
          if (list) list.push(edge);
          else seen.byTarget.set(edge.target, [edge]);
        }
        seen.offset += Buffer.byteLength(text.slice(0, complete), 'utf8');
      } finally {
        await file.close();
      }
    }
    return [...(seen.byTarget.get(label) ?? [])];
  }
  /** The record, and any temporary file an interrupted write of it left. */
  async delete(namespace: Namespace, label: string) {
    const file = this.#file(namespace, label);
    await rm(file, { force: true });
    const base = file.slice(file.lastIndexOf('/') + 1);
    let names: string[] = [];
    try { names = await readdir(join(this.root, namespace, 'items')); } catch { /* nothing stored */ }
    for (const name of names) if (name.startsWith(`${base}.`) && name.endsWith('.tmp')) await rm(join(this.root, namespace, 'items', name), { force: true });
  }
  async labels(namespace: Namespace) {
    try {
      return (await readdir(join(this.root, namespace, 'items'))).filter((name) => name.endsWith('.json')).map((name) => name.replace('-', ':').replace(/\.json$/, ''));
    } catch {
      return [];
    }
  }
}

/**
 * The Kappa Registry over its OCI and edge routes.
 *
 * UNVERIFIED against a live registry. Written from the registry's README:
 * blobs at /v2/{ns}/blobs/{digest} under a sha256 digest, tags at
 * /v2/{ns}/tags/{name}, edges at /v2/{ns}/edges/. The registry documents
 * sha256 blob digests only, so the kappa label is bound to the blob by a tag
 * named for it. `test/registry.test.ts` runs only when KAPPA_REGISTRY_URL is set.
 */
export class KappaRegistryStore implements Store {
  url: string;
  #token: string;
  names: Record<Namespace, string>;
  constructor(url: string, token: string, names: Record<Namespace, string>) {
    this.url = url;
    this.#token = token;
    this.names = names;
  }

  #headers(extra: Record<string, string> = {}) {
    return { authorization: `Bearer ${this.#token}`, ...extra };
  }
  #base = (namespace: Namespace) => `${this.url.replace(/\/$/, '')}/v2/${this.names[namespace]}`;
  #tag = (label: string) => label.replace(':', '-');

  async #call(method: string, url: string, body?: string | Uint8Array, type?: string) {
    const response = await fetch(url, { method, body: body as BodyInit | undefined, headers: this.#headers(type ? { 'content-type': type } : {}) });
    if (!response.ok && response.status !== 404) throw new Error(`kappa registry: ${method} ${url} answered ${response.status}`);
    return response;
  }

  admits?: (namespace: Namespace, item: Item) => boolean;
  async put(namespace: Namespace, item: Item) {
    return admitted(this, namespace, item, async () => {
      const label = labelOf(item);
      const bytes = new TextEncoder().encode(JSON.stringify(item));
      const digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
      await this.#call('PUT', `${this.#base(namespace)}/blobs/${digest}`, bytes, 'application/octet-stream');
      await this.#call('PUT', `${this.#base(namespace)}/tags/${this.#tag(label)}`, JSON.stringify({ kappa: digest }), 'application/json');
    });
  }
  async #digest(namespace: Namespace, label: string): Promise<string | undefined> {
    const response = await this.#call('GET', `${this.#base(namespace)}/tags/${this.#tag(label)}`);
    if (response.status === 404) return undefined;
    return ((await response.json()) as { kappa?: string }).kappa;
  }
  async get(namespace: Namespace, label: string) {
    const digest = await this.#digest(namespace, label);
    if (!digest) return undefined;
    const response = await this.#call('GET', `${this.#base(namespace)}/blobs/${digest}`);
    return response.status === 404 ? undefined : ((await response.json()) as Item);
  }
  async has(namespace: Namespace, label: string) {
    return (await this.#digest(namespace, label)) !== undefined;
  }
  async link(namespace: Namespace, edge: Edge) {
    await this.#call('PUT', `${this.#base(namespace)}/edges/`, JSON.stringify(edge), 'application/json');
  }
  async edgesTo(namespace: Namespace, label: string) {
    const response = await this.#call('GET', `${this.#base(namespace)}/edges/?target=${encodeURIComponent(label)}`);
    return response.status === 404 ? [] : ((await response.json()) as Edge[]);
  }
  async delete(namespace: Namespace, label: string) {
    const digest = await this.#digest(namespace, label);
    if (!digest) return;
    await this.#call('DELETE', `${this.#base(namespace)}/blobs/${digest}`);
    await this.#call('DELETE', `${this.#base(namespace)}/tags/${this.#tag(label)}`);
  }
  async labels(namespace: Namespace) {
    const response = await this.#call('GET', `${this.#base(namespace)}/tags/list`);
    if (response.status === 404) return [];
    const { tags = [] } = (await response.json()) as { tags?: string[] };
    return tags.map((tag) => tag.replace('-', ':'));
  }
}
