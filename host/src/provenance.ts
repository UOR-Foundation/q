// Provenance of a holo: which commit of which repository built these exact bytes, as GitHub's
// signed SLSA attestations say, verified with Sigstore against the one workflow allowed to sign.
// Used for both holos the agent runs: the community's decisions and its own kernel.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { verify } from 'sigstore';

const ISSUER = 'https://token.actions.githubusercontent.com';
const SLSA = 'https://slsa.dev/provenance/v1';

export interface Bundle { dsseEnvelope: { payload: string }; verificationMaterial: { tlogEntries: { integratedTime: string }[] } }
interface Statement {
  predicateType: string;
  subject: { digest: { sha256?: string } }[];
  predicate: { buildDefinition: { resolvedDependencies: { uri: string; digest: { gitCommit?: string } }[] } };
}

/** A definite no from GitHub, as opposed to GitHub being unreachable. */
class Refusal extends Error {}

export interface Attested {
  /** What GitHub's attestations name the bytes by. */
  sha256: string;
  /** The newest commit whose signed build is these bytes. */
  commit: string;
  /** When the transparency log recorded that signature. */
  signedAt: string;
}

/**
 * Verify every SLSA provenance bundle against the signer, keep the ones whose subject is these bytes
 * and whose source is the repository, and return the newest by transparency-log time. The same bytes
 * are often built from several commits; the newest is the repository as it is now.
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
  if (!found.length) throw new Error(`refused: no provenance signed by ${signer} names these bytes`);
  const newest = found.reduce((a, b) => (b.at > a.at ? b : a));
  return { commit: newest.commit, signedAt: new Date(newest.at * 1000).toISOString() };
}

export interface AttestOptions {
  repository: string;
  /** The workflow identity allowed to sign, such as https://github.com/OWNER/REPO/.github/workflows/holo.yml@refs/heads/main. */
  signer: string;
  /** Where the bundles last fetched for these bytes are kept, so a restart survives GitHub being unreachable. */
  cacheFile: string;
  githubToken?: string;
}

/**
 * Which commit built these exact bytes. Fetches GitHub's attestations for their SHA-256, or the cached
 * ones when GitHub cannot be reached, and verifies them either way: a cached bundle is trusted no more
 * than a fetched one.
 */
export async function attested(bytes: Uint8Array, options: AttestOptions): Promise<Attested> {
  const sha = createHash('sha256').update(bytes).digest('hex');
  let bundles: Bundle[];
  try {
    const response = await fetch(`https://api.github.com/repos/${options.repository}/attestations/sha256:${sha}`, {
      headers: { 'user-agent': 'uor-foundation-q', ...(options.githubToken ? { authorization: `Bearer ${options.githubToken}` } : {}) },
    });
    // 404 is an answer, not an outage: nobody signed these bytes. It never falls back to the cache.
    if (response.status === 404) throw new Refusal(`refused: no attestation in ${options.repository} names these bytes (sha256:${sha})`);
    if (!response.ok) throw new Error(`attestations: ${response.status}`);
    bundles = ((await response.json()) as { attestations: { bundle: Bundle }[] }).attestations.map((a) => a.bundle);
  } catch (error) {
    if (error instanceof Refusal) throw error;
    try {
      const cached = JSON.parse(await readFile(options.cacheFile, 'utf8')) as { sha256: string; bundles: Bundle[] };
      if (cached.sha256 !== `sha256:${sha}`) throw error;
      bundles = cached.bundles;
    } catch {
      throw error;
    }
  }
  const { commit, signedAt } = await provenance(bundles, sha, options.repository, options.signer);
  await writeFile(options.cacheFile, JSON.stringify({ sha256: `sha256:${sha}`, bundles }));
  return { sha256: `sha256:${sha}`, commit, signedAt };
}
