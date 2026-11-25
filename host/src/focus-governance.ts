// Connect a selected read-only governance strategy to revision-bound source
// observations. This is a host fact collector, not a compliance/authority
// decision or a production answer path.
import type { PublicInventory, PublicRead, RepositoryObservation, FilePath } from './focus-discovery.ts';
import { readPublicEvidence, codeownersSource, architectureRegisterHint, type SourceEvidence } from './focus-evidence.ts';
import type { StrategySelection } from './focus-strategy.ts';

type SourceRow = { repository: string; path: FilePath; evidence: SourceEvidence };
type GovernanceRoute = 'governance' | 'responsibility' | 'impact';
type Observation =
  | { state: 'not-collected'; reason: 'unsupported-route' | 'target-unobserved' | 'target-ambiguous' }
  | { state: 'collected'; intent: GovernanceRoute; repository: string; commit: string | null;
      observedAt: string; inventoryCoverage: PublicInventory['coverage'];
      sources: SourceRow[]; codeowners: ReturnType<typeof codeownersSource>;
      architecture: ReturnType<typeof architectureRegisterHint>;
      unresolved: string[] };

const foundation = 'UOR-Foundation/.github';
const localPaths: Record<GovernanceRoute, readonly FilePath[]> = {
  governance: ['GOVERNANCE.md', 'SECURITY.md', 'MAINTAINERS.md', 'ARCHITECTURE_INDEX.md'],
  responsibility: ['GOVERNANCE.md', 'MAINTAINERS.md', 'ARCHITECTURE_INDEX.md'],
  impact: ['ARCHITECTURE_INDEX.md'],
};
function routeOf(selection: StrategySelection): GovernanceRoute | null {
  if (selection.kind !== 'strategy') return null;
  if ((selection.intent === 'governance' || selection.intent === 'responsibility') &&
      selection.primary === 'governance-discovery') return selection.intent;
  if (selection.intent === 'impact' && selection.primary === 'reference-integrity-auditor') return 'impact';
  return null;
}

/** The target is a caller-confirmed full repository name, not an arbitrary
 * link or model-inferred source scope. The supplied inventory and reader
 * must have been collected for the same authorized public operation.
 * No retries, external link traversal, raw journal reads or permission changes.
 * Returned text is untrusted evidence, not instructions and not yet suitable
 * for public rendering. The existing Q pipeline must handle output privacy.
 */
export async function collectGovernanceSources(read: PublicRead, inventory: PublicInventory,
  selection: StrategySelection, target: string): Promise<Observation> {
  const intent = routeOf(selection);
  if (!intent) return { state: 'not-collected', reason: 'unsupported-route' };
  const matches = inventory.repositories.filter(r => r.repository === target);
  if (matches.length !== 1) return { state: 'not-collected', reason: matches.length ? 'target-ambiguous' : 'target-unobserved' };
  const repo = matches[0];
  const sources: SourceRow[] = [];
  const unresolved = new Set<string>();
  const collected = new Set<string>();
  const add = async (r: RepositoryObservation, path: FilePath): Promise<SourceEvidence> => {
    const key = r.repository + ':' + path;
    const existing = sources.find(s => s.repository + ':' + s.path === key);
    if (existing) return existing.evidence;
    // The route can request only the fixed bounded set below.
    if (collected.size >= 12) {
      unresolved.add('source-budget');
      return { state: 'unknown', reason: 'not-observed' };
    }
    collected.add(key);
    const evidence = await readPublicEvidence(read, r, path);
    sources.push({ repository: r.repository, path, evidence });
    if (evidence.state === 'unknown') unresolved.add('source-unavailable');
    return evidence;
  };
  if (inventory.coverage !== 'complete') unresolved.add('inventory-coverage');
  if (repo.tree !== 'complete') unresolved.add('target-tree-coverage');
  if (intent !== 'impact') {
    const org = inventory.repositories.filter(r => r.repository === foundation);
    if (org.length === 1) {
      await add(org[0], 'governance/GOVERNANCE.md');
      await add(org[0], 'MAINTAINERS.md');
      await add(org[0], 'governance/OPERATING_MODEL.md');
    } else unresolved.add('foundation-policy-unobserved');
  }
  let architecture: ReturnType<typeof architectureRegisterHint> = { state: 'unknown' };
  for (const path of localPaths[intent]) {
    const source = await add(repo, path);
    if (path === 'ARCHITECTURE_INDEX.md') architecture = architectureRegisterHint(source);
  }
  // Follow only the currently supported standard register, not arbitrary
  // Markdown links. A nonstandard hint remains a candidate, not resolved.
  if (architecture.state === 'candidate' && architecture.path === 'docs/README.md') {
    const register = await add(repo, 'docs/README.md');
    if (register.state !== 'bound') unresolved.add('architecture-register-unresolved');
  } else unresolved.add('architecture-register-unresolved');
  const codeowners = codeownersSource(repo);
  if (intent !== 'impact' && codeowners.state === 'candidate') {
    const source = await add(repo, codeowners.path);
    if (source.state !== 'bound') unresolved.add('codeowners-unresolved');
  }
  if (codeowners.state === 'unknown' && intent !== 'impact') unresolved.add('codeowners-unresolved');
  // Even a complete set of documents is not evidence of accepted roles,
  // effective rules, path matching, dependency impact or current task readiness.
  if (intent !== 'impact') unresolved.add('authority-and-effective-controls-unverified');
  if (intent === 'impact') unresolved.add('dependency-edges-unverified');
  return { state: 'collected', intent, repository: repo.repository, commit: repo.commit,
    observedAt: inventory.observedAt, inventoryCoverage: inventory.coverage,
    sources, codeowners, architecture, unresolved: [...unresolved] };
}
