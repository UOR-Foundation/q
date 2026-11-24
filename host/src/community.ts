// The community root: the one place Q's community context comes from.
//
// UOR-Foundation/community publishes its decision apps as one holo, and GitHub signs
// the build's SLSA provenance. Q pins that holo by its BLAKE3 kappa label, verifies
// the signature against the community's own Pages workflow, and takes from the
// provenance the newest commit that built those exact bytes. That one commit then
// fixes everything else Q reads from the community: the decision catalog, the
// channel labels of governance/discord.json, and the knowledge it indexes.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { kappa, load } from 'prism-code';
import { verify } from 'sigstore';
import type { ChannelFacts, Kernel } from './kernel.ts';

export interface CommunityPin {
  /** The holo's BLAKE3 kappa label, over its exact bytes. Its identity everywhere Q records it. */
  holo: string;
  /** The SHA-256 GitHub's attestation names. Only used to find and match the attestation. */
  sha256: string;
  /** The newest community commit whose signed build is these bytes. */
  commit: string;
  /** The workflow identity that signed the provenance. */
  signer: string;
  /** When the transparency log recorded that signature. */
  signedAt: string;
}

/** One input of a community decision: a choice among named values, or a whole number in a range. */
export type DecisionField =
  | { name: string; kind: 'choice'; values: string[]; means: string }
  | { name: string; kind: 'number'; min: number; max: number; means: string };
export interface DecisionApp { name: string; title: string; purpose: string; fields: DecisionField[] }

/** Whether a value is one this field can take, exactly as the community's prompt states it. */
export function accepts(field: DecisionField, value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (field.kind === 'choice') return field.values.includes(value);
  return /^(0|[1-9][0-9]*)$/.test(value) && Number(value) >= field.min && Number(value) <= field.max;
}

/** A field as the reader of a question is told it. */
export const describe = (field: DecisionField) =>
  field.kind === 'choice' ? `${field.name} (${field.values.join(' | ')}): ${field.means}` : `${field.name} (a whole number from ${field.min} to ${field.max}): ${field.means}`;

/** What Q needs to ask the community a decision. The real one is `Community`; tests pass a fake. */
export interface Decider {
  readonly pin: CommunityPin;
  readonly apps: ReadonlyMap<string, DecisionApp>;
  decide(app: string, values: string[]): Promise<string>;
}

export type Label = ChannelFacts['label'];
export interface ChannelLabels { default: Label; channels: Record<string, Label> }

export interface CommunityOptions {
  repository?: string;
  holoUrl?: string;
  signer?: string;
  /** Where the last verified holo and its provenance are kept, so a restart survives the network being down. */
  cacheDir: string;
  githubToken?: string;
}

const ISSUER = 'https://token.actions.githubusercontent.com';
const SLSA = 'https://slsa.dev/provenance/v1';
const LABELS: Label[] = ['public', 'unlabeled', 'excluded'];

interface Bundle { dsseEnvelope: { payload: string }; verificationMaterial: { tlogEntries: { integratedTime: string }[] } }
interface Statement {
  predicateType: string;
  subject: { digest: { sha256?: string } }[];
  predicate: { buildDefinition: { resolvedDependencies: { uri: string; digest: { gitCommit?: string } }[] } };
}

async function fetchOk(url: string, headers: Record<string, string> = {}): Promise<Response> {
  const response = await fetch(url, { headers: { 'user-agent': 'uor-discord-agent', ...headers } });
  if (!response.ok) throw new Error(`fetch ${url}: ${response.status}`);
  return response;
}

/**
 * Verify every SLSA provenance bundle against the signer, keep the ones whose subject is these bytes
 * and whose source is the repository, and return the newest by transparency-log time.
 */
export async function provenance(bundles: Bundle[], sha256: string, repository: string, signer: string): Promise<{ commit: string; signedAt: string }> {
  const found: { commit: string; at: number }[] = [];
  for (const bundle of bundles) {
    const statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, 'base64').toString('utf8')) as Statement;
    if (statement.predicateType !== SLSA) continue;
    if (!statement.subject.some((subject) => subject.digest.sha256 === sha256)) continue;
    const source = statement.predicate.buildDefinition.resolvedDependencies.find((d) => d.uri.startsWith(`git+https://github.com/${repository}@`));
    const commit = source?.digest.gitCommit;
    if (!commit || !/^[0-9a-f]{40}$/.test(commit)) continue;
    await verify(bundle as never, { certificateIssuer: ISSUER, certificateIdentityURI: signer });
    found.push({ commit, at: Number(bundle.verificationMaterial.tlogEntries[0]?.integratedTime ?? 0) });
  }
  if (!found.length) throw new Error(`community refused: no provenance signed by ${signer} names this holo`);
  const newest = found.reduce((a, b) => (b.at > a.at ? b : a));
  return { commit: newest.commit, signedAt: new Date(newest.at * 1000).toISOString() };
}

export class Community implements Decider {
  readonly pin: CommunityPin;
  readonly apps: ReadonlyMap<string, DecisionApp>;
  readonly labels: ChannelLabels;
  readonly repository: string;
  /** Prompt files whose examples the holo does not all answer as stated. Left out of the catalog, and logged. */
  readonly skipped: string[];
  #dispatch: (request: Uint8Array) => Promise<Uint8Array>;

  private constructor(pin: CommunityPin, apps: Map<string, DecisionApp>, skipped: string[], labels: ChannelLabels, repository: string, dispatch: (request: Uint8Array) => Promise<Uint8Array>) {
    this.pin = pin; this.apps = apps; this.skipped = skipped; this.labels = labels; this.repository = repository; this.#dispatch = dispatch;
  }

  static async open(options: CommunityOptions): Promise<Community> {
    const repository = options.repository ?? 'UOR-Foundation/community';
    const holoUrl = options.holoUrl ?? 'https://uor-foundation.github.io/community/app.holo';
    const signer = options.signer ?? `https://github.com/${repository}/.github/workflows/pages.yml@refs/heads/main`;
    const api: Record<string, string> = options.githubToken ? { authorization: `Bearer ${options.githubToken}` } : {};
    await mkdir(options.cacheDir, { recursive: true });
    const cached = { holo: join(options.cacheDir, 'community.holo'), bundles: join(options.cacheDir, 'community.provenance.json') };

    // The newest published holo and its provenance; the cached pair only when the network is down.
    let bytes: Uint8Array;
    let bundles: Bundle[];
    try {
      bytes = new Uint8Array(await (await fetchOk(holoUrl)).arrayBuffer());
      const sha = createHash('sha256').update(bytes).digest('hex');
      const listed = (await (await fetchOk(`https://api.github.com/repos/${repository}/attestations/sha256:${sha}`, api)).json()) as { attestations: { bundle: Bundle }[] };
      bundles = listed.attestations.map((a) => a.bundle);
    } catch (error) {
      try {
        bytes = new Uint8Array(await readFile(cached.holo));
        bundles = JSON.parse(await readFile(cached.bundles, 'utf8')) as Bundle[];
      } catch {
        throw error;
      }
    }

    // Verified again whichever way it came: a cached file is no more trusted than a fetched one.
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const { commit, signedAt } = await provenance(bundles, sha256, repository, signer);
    const app = await load(bytes);
    if (!app.identities.verified) throw new Error('community refused: the holo failed identity verification');
    const replay = await app.acceptance();
    if (replay.total === 0 || replay.passed !== replay.total) throw new Error(`community refused: ${replay.passed} of ${replay.total} acceptance vectors replayed`);
    await writeFile(cached.holo, bytes);
    await writeFile(cached.bundles, JSON.stringify(bundles));

    // Everything else at that one commit.
    const raw = (path: string) => fetchOk(`https://raw.githubusercontent.com/${repository}/${commit}/${path}`).then((r) => r.text());
    const listing = (await (await fetchOk(`https://api.github.com/repos/${repository}/contents/apps?ref=${commit}`, api)).json()) as { name: string; type: string }[];
    // An app enters the catalog only when the holo answers every example its prompt states, exactly:
    // the catalog Q reads questions against and the holo Q asks can then not disagree.
    const dispatch = async (request: string) => new TextDecoder().decode(await app.dispatch(new TextEncoder().encode(request)));
    const apps = new Map<string, DecisionApp>();
    const skipped: string[] = [];
    for (const entry of listing) {
      if (entry.type !== 'file' || !entry.name.endsWith('.prompt.json')) continue;
      type Raw = { name: string; kind?: string; values?: string[]; min?: number; max?: number; means: string };
      const prompt = JSON.parse(await raw(`apps/${entry.name}`)) as { app?: { name: string; title: string; purpose: string; fields?: Raw[]; examples?: { request: string; response: string }[] } };
      const declared = prompt.app;
      const fields = declared?.fields?.map((f): DecisionField | null =>
        f.kind === 'number' && Number.isInteger(f.min) && Number.isInteger(f.max) ? { name: f.name, kind: 'number', min: f.min!, max: f.max!, means: f.means }
        : Array.isArray(f.values) ? { name: f.name, kind: 'choice', values: f.values, means: f.means }
        : null);
      const examples = declared?.examples ?? [];
      let agrees = Boolean(declared && fields?.length && fields.every(Boolean) && examples.length);
      for (const example of agrees ? examples : []) {
        if ((await dispatch(`${declared!.name} ${example.request}`)) !== example.response) { agrees = false; break; }
      }
      if (!agrees) { skipped.push(entry.name); continue; }
      apps.set(declared!.name, { name: declared!.name, title: declared!.title, purpose: declared!.purpose, fields: fields as DecisionField[] });
    }
    const governance = JSON.parse(await raw('governance/discord.json')) as { labels: { default: string; channels: Record<string, string> } };
    const labels = channelLabels(governance.labels);

    const pin: CommunityPin = { holo: kappa(bytes), sha256: `sha256:${sha256}`, commit, signer, signedAt };
    return new Community(pin, apps, skipped, labels, repository, (request) => app.dispatch(request));
  }

  /** Ask one decision. Values are checked against the app's own fields first, so a request is never guessed. */
  async decide(name: string, values: string[]): Promise<string> {
    const app = this.apps.get(name);
    if (!app) throw new Error(`no community decision named ${name}`);
    if (values.length !== app.fields.length || app.fields.some((field, i) => !accepts(field, values[i]))) {
      throw new Error(`invalid inputs for ${name}`);
    }
    return new TextDecoder().decode(await this.#dispatch(new TextEncoder().encode(`${name} ${values.join(' ')}`)));
  }

  /** A channel's label: its own entry in governance/discord.json, else the file's default. A thread takes its parent's. */
  label(ids: string[]): Label {
    for (const id of ids) if (this.labels.channels[id]) return this.labels.channels[id];
    return this.labels.default;
  }
}

/** Refuse a label governance/discord.json could not mean, rather than guess one. */
export function channelLabels(labels: { default: string; channels: Record<string, string> }): ChannelLabels {
  const known = (value: string): Label => {
    if (!LABELS.includes(value as Label)) throw new Error(`community refused: unknown channel label ${value}`);
    return value as Label;
  };
  return { default: known(labels.default), channels: Object.fromEntries(Object.entries(labels.channels ?? {}).map(([id, label]) => [id, known(label)])) };
}

const READ = { kind: ['text', 'forum', 'voice', 'dm'], visibility: ['everyone', 'restricted'], label: ['public', 'unlabeled', 'excluded'], install: ['admin', 'other'], intent: ['granted', 'missing'] } as const;

/**
 * Q's read policy is imported from the community's uor-discord-read. Ask both every one of the
 * 96 requests the policy has, and list each one they answer differently. Empty means they agree everywhere.
 */
export async function readPolicyDrift(kernel: Kernel, community: Decider): Promise<string[]> {
  const differ: string[] = [];
  for (const kind of READ.kind) for (const visibility of READ.visibility) for (const label of READ.label) for (const install of READ.install) for (const intent of READ.intent) {
    const ours = await kernel.read({ kind, visibility, label, install, intent });
    const theirs = await community.decide('uor-discord-read', [kind, visibility, label, install, intent]);
    if (ours !== theirs) differ.push(`${kind} ${visibility} ${label} ${install} ${intent}: Q ${ours}, community ${theirs}`);
  }
  return differ;
}
