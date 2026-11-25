// Prototype, not wired into Q: bind selected public source bytes to observed
// Git identities. Output is evidence for interpretation, not a policy verdict.
import { createHash } from 'node:crypto';
import type { PublicRead, RepositoryObservation, FilePath } from './focus-discovery.ts';

const SHA = /^[a-f0-9]{40}$/;
const REPO = /^UOR-Foundation\/[A-Za-z0-9_.-]{1,100}$/;
const MAX_BYTES = 128 * 1024;
const PUBLIC_TEXT = [
  'GOVERNANCE.md', 'SECURITY.md', 'MAINTAINERS.md', 'ARCHITECTURE_INDEX.md', 'docs/README.md',
  '.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS',
  'governance/GOVERNANCE.md', 'governance/OPERATING_MODEL.md', 'governance/CONFORMANCE_REPORTING.md',
] as const satisfies readonly FilePath[];
type TextPath = typeof PUBLIC_TEXT[number];

export type SourceEvidence =
  | { state: 'bound'; repository: string; commit: string; path: TextPath; blob: string; url: string; text: string }
  | { state: 'absent' | 'unknown'; reason: 'complete-tree-absence' | 'not-observed' | 'invalid-binding' | 'unavailable' | 'invalid-content' };

function obj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** The caller must independently enforce public visibility at read time,
 * fixed GitHub origin, no redirects, maximum response bytes and deadlines.
 * Returned text is untrusted data and must not be displayed or executed
 * without separate audience and content review.
 */
export async function readPublicEvidence(read: PublicRead, repo: RepositoryObservation, path: FilePath): Promise<SourceEvidence> {
  if (!PUBLIC_TEXT.includes(path as TextPath) || !REPO.test(repo.repository) ||
      repo.repository.endsWith('/.') || repo.repository.endsWith('/..') ||
      !repo.commit || !SHA.test(repo.commit)) return { state: 'unknown', reason: 'invalid-binding' };
  if (repo.files[path] === 'absent' && repo.tree === 'complete') return { state: 'absent', reason: 'complete-tree-absence' };
  const expected = repo.blobs[path];
  if (repo.files[path] !== 'present' || !expected || !SHA.test(expected)) return { state: 'unknown', reason: 'not-observed' };
  let raw: unknown;
  try { raw = await read('/repos/' + repo.repository + '/git/blobs/' + expected); }
  catch { return { state: 'unknown', reason: 'unavailable' }; }
  if (!obj(raw) || raw.sha !== expected || raw.encoding !== 'base64' ||
      typeof raw.size !== 'number' || !Number.isSafeInteger(raw.size) || raw.size < 0 || raw.size > MAX_BYTES ||
      typeof raw.content !== 'string' || raw.content.length > MAX_BYTES * 2 ||
      /[^A-Za-z0-9+/=\r\n]/.test(raw.content)) return { state: 'unknown', reason: 'invalid-content' };
  const encoded = raw.content.replace(/[\r\n]/g, '');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length !== raw.size || bytes.toString('base64') !== encoded) return { state: 'unknown', reason: 'invalid-content' };
  const actual = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
  if (actual !== expected) return { state: 'unknown', reason: 'invalid-binding' };
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return { state: 'unknown', reason: 'invalid-content' }; }
  if (text.includes('\0')) return { state: 'unknown', reason: 'invalid-content' };
  return { state: 'bound', repository: repo.repository, commit: repo.commit, path: path as TextPath,
    blob: expected, url: 'https://github.com/' + repo.repository + '/blob/' + repo.commit + '/' + path, text };
}

/** Only select the first observed CODEOWNERS location in platform precedence
 * order; a higher-precedence unknown prevents selecting a lower one. The
 * result is a source candidate, not a resolved code owner or an approval.
 */
export function codeownersSource(repo: RepositoryObservation):
  { state: 'candidate'; path: TextPath } | { state: 'absent' | 'unknown' } {
  for (const path of ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'] as const) {
    if (repo.files[path] === 'present' && repo.blobs[path] && SHA.test(repo.blobs[path]!)) return { state: 'candidate', path };
    if (repo.files[path] !== 'absent' || repo.tree !== 'complete') return { state: 'unknown' };
  }
  return { state: 'absent' };
}

/** A conservative navigation hint for the current Qortara index convention.
 * Do not interpret arbitrary Markdown or follow any link here. A future
 * qualified parser can extend this; unknown is not proof of no register.
 */
export function architectureRegisterHint(index: SourceEvidence):
  { state: 'candidate'; path: string } | { state: 'unknown' } {
  if (index.state !== 'bound' || index.path !== 'ARCHITECTURE_INDEX.md') return { state: 'unknown' };
  const lines = index.text.split(/\r?\n/);
  // Restrict to the single supported canonical sentence. Refuse multiple
  // Markdown links, code fences/comments/HTML, and ambiguous documents rather
  // than attempt an incomplete general Markdown parser.
  if (/[<>`]/.test(index.text)) return { state: 'unknown' };
  const links = [...index.text.matchAll(/\[[^\]\n]+\]\(([^)\n]+)\)/g)];
  if (links.length !== 1) return { state: 'unknown' };
  const line = lines.find(l => /^The single canonical architecture owner register is \[Owner register\]\([^)]+\)\.$/.test(l));
  if (!line) return { state: 'unknown' };
  const path = links[0][1];
  if (!/^docs\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.md$/.test(path)) return { state: 'unknown' };
  return { state: 'candidate', path };
}
