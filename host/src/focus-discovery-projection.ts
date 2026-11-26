// Deterministic discovery projection for Q Focus. The model receives a bounded
// set of candidates, never a dump of every issue body, repository or document.
// Native metadata is a discovery hint, not evidence of priority or readiness.
import type { LiveWorkSnapshot, WorkItem } from './focus-live-work.ts';

export type DiscoveryFilter = {
  repository?: string;
  topic?: string;
  label?: string;
  kind?: WorkItem['kind'];
};
export type DiscoveryProjection = {
  startedAt: string;
  finishedAt: string;
  sourceCoverage: LiveWorkSnapshot['coverage'];
  matchingRepositories: number;
  matchingItems: number;
  unknownMetadataRepositories: number;
  unknownMetadataItems: number;
  unavailableRepositories: number;
  omittedRepositories: number;
  omittedMatchingItems: number;
  selection: 'bounded-discovery-not-priority-ranking';
  /** Items GitHub reports as blocking or blocked by others, among the matches: explicit native evidence only. */
  explicitBlocking: number; explicitlyBlocked: number; unknownDependencyCounts: number;
  candidates: { repository: string; number: number; kind: WorkItem['kind']; url: string; title: string; updatedAt: string }[];
};
const text = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 100 && !/[\x00-\x1f\x7f]/.test(s);

/** Filter only explicitly supplied, exact metadata terms; never infer meaning
 * or grant authority from a repository topic, issue label, title or age.
 * The stable ordering is presentation only. A capped result cannot establish
 * the best contribution. This module does not call an LLM or access sources.
 */
export function projectDiscovery(snapshot: LiveWorkSnapshot, filter: DiscoveryFilter = {}, limit = 12): DiscoveryProjection {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20 ||
      (filter.repository !== undefined && (!text(filter.repository) || !/^UOR-Foundation\/[A-Za-z0-9_.-]+$/.test(filter.repository))) ||
      (filter.topic !== undefined && !text(filter.topic)) ||
      (filter.label !== undefined && !text(filter.label)) ||
      (filter.kind !== undefined && filter.kind !== 'issue' && filter.kind !== 'pull')) throw RangeError('invalid discovery filter');
  let matchingRepositories = 0, unknownMetadataRepositories = 0, unknownMetadataItems = 0, unavailableRepositories = 0;
  const matches: WorkItem[] = [];
  for (const repo of snapshot.repositories) {
    if (filter.repository !== undefined && repo.repository.toLowerCase() !== filter.repository.toLowerCase()) continue;
    if (repo.coverage !== 'complete') unavailableRepositories++;
    if (filter.topic !== undefined) {
      if (repo.topics === null) { unknownMetadataRepositories++; continue; }
      if (!repo.topics.includes(filter.topic)) continue;
    }
    matchingRepositories++;
    for (const item of repo.items) {
      if (filter.kind !== undefined && item.kind !== filter.kind) continue;
      if (filter.label !== undefined) {
        if (item.labels === null) { unknownMetadataItems++; continue; }
        if (!item.labels.includes(filter.label)) continue;
      }
      matches.push(item);
    }
  }
  // Explicit native evidence first: GitHub's own counts of items this blocks (downstream unlocks) lead, explicitly
  // blocked items (not ready) come last, and everything else is between. No recency, popularity or label is a priority.
  const tier = (i: WorkItem) => (i.blockedBy ?? 0) > 0 ? 2 : (i.blocking ?? 0) > 0 ? 0 : 1;
  const repoKey = (r: string) => r.toLowerCase();
  matches.sort((a,b) => tier(a) - tier(b) || (b.blocking ?? 0) - (a.blocking ?? 0) ||
    (repoKey(a.repository) < repoKey(b.repository) ? -1 : repoKey(a.repository) > repoKey(b.repository) ? 1 : a.number - b.number));
  // Within a tier: breadth before depth, one item from each repository before a second from any, starting at a
  // repository that rotates each hour, so a fixed alphabetical prefix is not always the sample. Still a disclosed
  // sample, never a ranking.
  const hour = Math.floor(Date.parse(snapshot.startedAt) / 3_600_000);
  const sample:WorkItem[]=[];
  for (const level of [0, 1, 2]) {
    const inTier = matches.filter(i => tier(i) === level);
    const groups = new Map<string,WorkItem[]>();
    for (const item of inTier) { const list = groups.get(item.repository) ?? []; list.push(item); groups.set(item.repository, list); }
    const lists = [...groups.values()];
    // Explicit blockers keep their evidence order; the undifferentiated middle and blocked tiers rotate.
    const offset = level === 0 || !lists.length || !Number.isFinite(hour) ? 0 : ((hour % lists.length) + lists.length) % lists.length;
    const rotated = [...lists.slice(offset), ...lists.slice(0, offset)];
    for (let round = 0; sample.length < limit && rotated.some(l => l[round]); round++)
      for (const list of rotated) { if (sample.length === limit) break; if (list[round]) sample.push(list[round]); }
    if (sample.length === limit) break;
  }
  const candidates = sample.map(i => ({
    repository: i.repository, number: i.number, kind: i.kind, url: i.url, title: i.title, updatedAt: i.updatedAt,
  }));
  return { startedAt: snapshot.startedAt, finishedAt: snapshot.finishedAt, sourceCoverage: snapshot.coverage,
    matchingRepositories, matchingItems: matches.length, unknownMetadataRepositories, unknownMetadataItems,
    unavailableRepositories, omittedRepositories: snapshot.omittedRepositories, omittedMatchingItems: matches.length - candidates.length,
    selection: 'bounded-discovery-not-priority-ranking', candidates,
    explicitBlocking: matches.filter(i => tier(i) === 0).length, explicitlyBlocked: matches.filter(i => tier(i) === 2).length, unknownDependencyCounts: matches.filter(i => i.blocking == null || i.blockedBy == null).length };
}
