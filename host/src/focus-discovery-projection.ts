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
    if (filter.repository !== undefined && repo.repository !== filter.repository) continue;
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
  matches.sort((a,b) => a.repository < b.repository ? -1 : a.repository > b.repository ? 1 : a.number - b.number);
  const candidates = matches.slice(0,limit).map(i => ({
    repository: i.repository, number: i.number, kind: i.kind, url: i.url, title: i.title, updatedAt: i.updatedAt,
  }));
  return { startedAt: snapshot.startedAt, finishedAt: snapshot.finishedAt, sourceCoverage: snapshot.coverage,
    matchingRepositories, matchingItems: matches.length, unknownMetadataRepositories, unknownMetadataItems,
    unavailableRepositories, omittedRepositories: snapshot.omittedRepositories, omittedMatchingItems: matches.length - candidates.length,
    selection: 'bounded-discovery-not-priority-ranking', candidates };
}
