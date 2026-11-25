// Read-only public GitHub transport for the Focus prototype. No credentials,
// redirects, arbitrary hosts, request bodies or external URL dereferencing.
import type { PublicRead } from './focus-discovery.ts';

const ORIGIN = 'https://api.github.com';
const REPO = '[A-Za-z0-9_.-]{1,100}';
const ROOT = '/repos/UOR-Foundation/';
const SHA = '[a-f0-9]{40}';
const listing = /^\/orgs\/UOR-Foundation\/repos\?type=public&sort=full_name&direction=asc&per_page=100&page=([1-9][0-9]{0,2})$/;
const tree = new RegExp('^' + ROOT + '(' + REPO + ')/git/trees/' + SHA + '\\?recursive=1$');
const blob = new RegExp('^' + ROOT + '(' + REPO + ')/git/blobs/' + SHA + '$');
const commit = new RegExp('^' + ROOT + '(' + REPO + ')/commits/([^/?#]+)$');

const backlog = new RegExp('^' + ROOT + '(' + REPO + ')/issues\\?state=open&sort=created&direction=asc&per_page=100&page=([1-9][0-9]{0,2})
  if (path.length > 1400) return false;
  const list = listing.exec(path);
  if (list) return Number(list[1]) <= 100;
  const work = backlog.exec(path) ?? checks.exec(path);
  if (work) return work[1] !== '.' && work[1] !== '..' && Number(work[2]) <= 100;
  const pr = pull.exec(path);
  if (pr) return pr[1] !== '.' && pr[1] !== '..' && Number.isSafeInteger(Number(pr[2]));
  const match = tree.exec(path) ?? blob.exec(path) ?? commit.exec(path);
  if (!match || match[1] === '.' || match[1] === '..') return false;
  if (match.length === 3) {
    let ref: string;
    try { ref = decodeURIComponent(match[2]); } catch { return false; }
    // Require the same canonical encoding produced by the collector.
    if (encodeURIComponent(ref) !== match[2] || ref.length > 255 ||
        /[\x00-\x20\x7f~^:?*\[\\]/.test(ref) || ref.includes('%') || ref.includes('..') ||
        ref.includes('@{') || ref.split('/').some(s => !s || s.startsWith('.') || s.endsWith('.') || s.endsWith('.lock'))) return false;
  }
  return true;
}

export interface PublicReadOptions {
  maxRequests?: number;
  maxBytes?: number;
  maxTotalBytes?: number;
  deadlineMs?: number;
  signal?: AbortSignal;
  /** Injectable only for isolated tests. Runtime uses global fetch. */
  fetcher?: typeof fetch;
}
export interface PublicReadStats {
  requests: number;
  bytes: number;
  exhausted: boolean;
}
function integer(n: number, max: number): number {
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new RangeError('invalid public read budget');
  return n;
}

/** A per-operation anonymous transport. Public access is limited to what
 * GitHub exposes to an unauthenticated request at read time. This is not
 * a private-org connector; unauthenticated rate limits can truncate coverage.
 * No cache. Errors are deliberately fixed strings, not remote payloads.
 */
export function createPublicRead(options: PublicReadOptions = {}): { read: PublicRead; stats: () => PublicReadStats } {
  const maxRequests = integer(options.maxRequests ?? 40, 200);
  const maxBytes = integer(options.maxBytes ?? 4 * 1024 * 1024, 8 * 1024 * 1024);
  const maxTotalBytes = integer(options.maxTotalBytes ?? 16 * 1024 * 1024, 32 * 1024 * 1024);
  const duration = integer(options.deadlineMs ?? 15000, 60000);
  const deadline = performance.now() + duration;
  const fetcher = options.fetcher ?? fetch;
  let requests = 0, bytes = 0, exhausted = false, active = false;
  const read: PublicRead = async path => {
    if (!allowed(path)) throw new Error('public read path refused');
    // The collector is sequential. Reject accidental concurrency rather than
    // allowing competing streams to overspend the shared byte budget.
    if (active) throw new Error('public read already active');
    const remaining = Math.floor(deadline - performance.now());
    if (exhausted || requests >= maxRequests || bytes >= maxTotalBytes || remaining <= 0 || options.signal?.aborted) {
      exhausted = true; throw new Error('public read budget exhausted');
    }
    const url = new URL(path, ORIGIN);
    if (url.origin !== ORIGIN || url.pathname + url.search !== path) throw new Error('public read path refused');
    active = true;
    requests++;
    const timeout = AbortSignal.timeout(remaining);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      const res = await fetcher(url, { method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
        headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }, signal });
      if (res.status === 403 || res.status === 429) exhausted = true;
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => {});
        throw new Error('public read unavailable');
      }
      if (res.redirected || (res.url && res.url !== url.href)) {
        await res.body.cancel().catch(() => {});
        throw new Error('public read unavailable');
      }
      const length = res.headers.get('content-length');
      const cap = Math.min(maxBytes, maxTotalBytes - bytes);
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > cap)) {
        exhausted = true; await res.body.cancel().catch(() => {}); throw new Error('public read byte budget');
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let size = 0, text = '';
      try {
        for (;;) {
          if (signal.aborted || performance.now() >= deadline) { exhausted = true; throw new Error('public read deadline'); }
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          bytes += part.value.byteLength;
          if (size > cap || bytes > maxTotalBytes) { exhausted = true; throw new Error('public read byte budget'); }
          text += decoder.decode(part.value, { stream: true });
        }
        text += decoder.decode();
        if (signal.aborted || performance.now() >= deadline) { exhausted = true; throw new Error('public read deadline'); }
        return JSON.parse(text) as unknown;
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    } catch {
      if (signal.aborted) exhausted = true;
      throw new Error('public read unavailable');
    } finally { active = false; }
  };
  return { read, stats: () => ({ requests, bytes, exhausted }) };
}
);
const pull = new RegExp('^' + ROOT + '(' + REPO + ')/pulls/([1-9][0-9]{0,14})
  if (path.length > 1400) return false;
  const list = listing.exec(path);
  if (list) return Number(list[1]) <= 100;
  const match = tree.exec(path) ?? blob.exec(path) ?? commit.exec(path);
  if (!match || match[1] === '.' || match[1] === '..') return false;
  if (match.length === 3) {
    let ref: string;
    try { ref = decodeURIComponent(match[2]); } catch { return false; }
    // Require the same canonical encoding produced by the collector.
    if (encodeURIComponent(ref) !== match[2] || ref.length > 255 ||
        /[\x00-\x20\x7f~^:?*\[\\]/.test(ref) || ref.includes('%') || ref.includes('..') ||
        ref.includes('@{') || ref.split('/').some(s => !s || s.startsWith('.') || s.endsWith('.') || s.endsWith('.lock'))) return false;
  }
  return true;
}

export interface PublicReadOptions {
  maxRequests?: number;
  maxBytes?: number;
  maxTotalBytes?: number;
  deadlineMs?: number;
  signal?: AbortSignal;
  /** Injectable only for isolated tests. Runtime uses global fetch. */
  fetcher?: typeof fetch;
}
export interface PublicReadStats {
  requests: number;
  bytes: number;
  exhausted: boolean;
}
function integer(n: number, max: number): number {
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new RangeError('invalid public read budget');
  return n;
}

/** A per-operation anonymous transport. Public access is limited to what
 * GitHub exposes to an unauthenticated request at read time. This is not
 * a private-org connector; unauthenticated rate limits can truncate coverage.
 * No cache. Errors are deliberately fixed strings, not remote payloads.
 */
export function createPublicRead(options: PublicReadOptions = {}): { read: PublicRead; stats: () => PublicReadStats } {
  const maxRequests = integer(options.maxRequests ?? 40, 200);
  const maxBytes = integer(options.maxBytes ?? 4 * 1024 * 1024, 8 * 1024 * 1024);
  const maxTotalBytes = integer(options.maxTotalBytes ?? 16 * 1024 * 1024, 32 * 1024 * 1024);
  const duration = integer(options.deadlineMs ?? 15000, 60000);
  const deadline = performance.now() + duration;
  const fetcher = options.fetcher ?? fetch;
  let requests = 0, bytes = 0, exhausted = false, active = false;
  const read: PublicRead = async path => {
    if (!allowed(path)) throw new Error('public read path refused');
    // The collector is sequential. Reject accidental concurrency rather than
    // allowing competing streams to overspend the shared byte budget.
    if (active) throw new Error('public read already active');
    const remaining = Math.floor(deadline - performance.now());
    if (exhausted || requests >= maxRequests || bytes >= maxTotalBytes || remaining <= 0 || options.signal?.aborted) {
      exhausted = true; throw new Error('public read budget exhausted');
    }
    const url = new URL(path, ORIGIN);
    if (url.origin !== ORIGIN || url.pathname + url.search !== path) throw new Error('public read path refused');
    active = true;
    requests++;
    const timeout = AbortSignal.timeout(remaining);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      const res = await fetcher(url, { method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
        headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }, signal });
      if (res.status === 403 || res.status === 429) exhausted = true;
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => {});
        throw new Error('public read unavailable');
      }
      if (res.redirected || (res.url && res.url !== url.href)) {
        await res.body.cancel().catch(() => {});
        throw new Error('public read unavailable');
      }
      const length = res.headers.get('content-length');
      const cap = Math.min(maxBytes, maxTotalBytes - bytes);
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > cap)) {
        exhausted = true; await res.body.cancel().catch(() => {}); throw new Error('public read byte budget');
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let size = 0, text = '';
      try {
        for (;;) {
          if (signal.aborted || performance.now() >= deadline) { exhausted = true; throw new Error('public read deadline'); }
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          bytes += part.value.byteLength;
          if (size > cap || bytes > maxTotalBytes) { exhausted = true; throw new Error('public read byte budget'); }
          text += decoder.decode(part.value, { stream: true });
        }
        text += decoder.decode();
        if (signal.aborted || performance.now() >= deadline) { exhausted = true; throw new Error('public read deadline'); }
        return JSON.parse(text) as unknown;
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    } catch {
      if (signal.aborted) exhausted = true;
      throw new Error('public read unavailable');
    } finally { active = false; }
  };
  return { read, stats: () => ({ requests, bytes, exhausted }) };
}
);
const checks = new RegExp('^' + ROOT + '(' + REPO + ')/commits/' + SHA + '/check-runs\\?filter=latest&per_page=100&page=([1-9][0-9]{0,2})
  if (path.length > 1400) return false;
  const list = listing.exec(path);
  if (list) return Number(list[1]) <= 100;
  const match = tree.exec(path) ?? blob.exec(path) ?? commit.exec(path);
  if (!match || match[1] === '.' || match[1] === '..') return false;
  if (match.length === 3) {
    let ref: string;
    try { ref = decodeURIComponent(match[2]); } catch { return false; }
    // Require the same canonical encoding produced by the collector.
    if (encodeURIComponent(ref) !== match[2] || ref.length > 255 ||
        /[\x00-\x20\x7f~^:?*\[\\]/.test(ref) || ref.includes('%') || ref.includes('..') ||
        ref.includes('@{') || ref.split('/').some(s => !s || s.startsWith('.') || s.endsWith('.') || s.endsWith('.lock'))) return false;
  }
  return true;
}

export interface PublicReadOptions {
  maxRequests?: number;
  maxBytes?: number;
  maxTotalBytes?: number;
  deadlineMs?: number;
  signal?: AbortSignal;
  /** Injectable only for isolated tests. Runtime uses global fetch. */
  fetcher?: typeof fetch;
}
export interface PublicReadStats {
  requests: number;
  bytes: number;
  exhausted: boolean;
}
function integer(n: number, max: number): number {
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new RangeError('invalid public read budget');
  return n;
}

/** A per-operation anonymous transport. Public access is limited to what
 * GitHub exposes to an unauthenticated request at read time. This is not
 * a private-org connector; unauthenticated rate limits can truncate coverage.
 * No cache. Errors are deliberately fixed strings, not remote payloads.
 */
export function createPublicRead(options: PublicReadOptions = {}): { read: PublicRead; stats: () => PublicReadStats } {
  const maxRequests = integer(options.maxRequests ?? 40, 200);
  const maxBytes = integer(options.maxBytes ?? 4 * 1024 * 1024, 8 * 1024 * 1024);
  const maxTotalBytes = integer(options.maxTotalBytes ?? 16 * 1024 * 1024, 32 * 1024 * 1024);
  const duration = integer(options.deadlineMs ?? 15000, 60000);
  const deadline = performance.now() + duration;
  const fetcher = options.fetcher ?? fetch;
  let requests = 0, bytes = 0, exhausted = false, active = false;
  const read: PublicRead = async path => {
    if (!allowed(path)) throw new Error('public read path refused');
    // The collector is sequential. Reject accidental concurrency rather than
    // allowing competing streams to overspend the shared byte budget.
    if (active) throw new Error('public read already active');
    const remaining = Math.floor(deadline - performance.now());
    if (exhausted || requests >= maxRequests || bytes >= maxTotalBytes || remaining <= 0 || options.signal?.aborted) {
      exhausted = true; throw new Error('public read budget exhausted');
    }
    const url = new URL(path, ORIGIN);
    if (url.origin !== ORIGIN || url.pathname + url.search !== path) throw new Error('public read path refused');
    active = true;
    requests++;
    const timeout = AbortSignal.timeout(remaining);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      const res = await fetcher(url, { method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
        headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }, signal });
      if (res.status === 403 || res.status === 429) exhausted = true;
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => {});
        throw new Error('public read unavailable');
      }
      if (res.redirected || (res.url && res.url !== url.href)) {
        await res.body.cancel().catch(() => {});
        throw new Error('public read unavailable');
      }
      const length = res.headers.get('content-length');
      const cap = Math.min(maxBytes, maxTotalBytes - bytes);
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > cap)) {
        exhausted = true; await res.body.cancel().catch(() => {}); throw new Error('public read byte budget');
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let size = 0, text = '';
      try {
        for (;;) {
          if (signal.aborted || performance.now() >= deadline) { exhausted = true; throw new Error('public read deadline'); }
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          bytes += part.value.byteLength;
          if (size > cap || bytes > maxTotalBytes) { exhausted = true; throw new Error('public read byte budget'); }
          text += decoder.decode(part.value, { stream: true });
        }
        text += decoder.decode();
        if (signal.aborted || performance.now() >= deadline) { exhausted = true; throw new Error('public read deadline'); }
        return JSON.parse(text) as unknown;
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    } catch {
      if (signal.aborted) exhausted = true;
      throw new Error('public read unavailable');
    } finally { active = false; }
  };
  return { read, stats: () => ({ requests, bytes, exhausted }) };
}
);

function allowed(path: string): boolean {
  if (path.length > 1400) return false;
  const list = listing.exec(path);
  if (list) return Number(list[1]) <= 100;
  const match = tree.exec(path) ?? blob.exec(path) ?? commit.exec(path);
  if (!match || match[1] === '.' || match[1] === '..') return false;
  if (match.length === 3) {
    let ref: string;
    try { ref = decodeURIComponent(match[2]); } catch { return false; }
    // Require the same canonical encoding produced by the collector.
    if (encodeURIComponent(ref) !== match[2] || ref.length > 255 ||
        /[\x00-\x20\x7f~^:?*\[\\]/.test(ref) || ref.includes('%') || ref.includes('..') ||
        ref.includes('@{') || ref.split('/').some(s => !s || s.startsWith('.') || s.endsWith('.') || s.endsWith('.lock'))) return false;
  }
  return true;
}

export interface PublicReadOptions {
  maxRequests?: number;
  maxBytes?: number;
  maxTotalBytes?: number;
  deadlineMs?: number;
  signal?: AbortSignal;
  /** Injectable only for isolated tests. Runtime uses global fetch. */
  fetcher?: typeof fetch;
}
export interface PublicReadStats {
  requests: number;
  bytes: number;
  exhausted: boolean;
}
function integer(n: number, max: number): number {
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new RangeError('invalid public read budget');
  return n;
}

/** A per-operation anonymous transport. Public access is limited to what
 * GitHub exposes to an unauthenticated request at read time. This is not
 * a private-org connector; unauthenticated rate limits can truncate coverage.
 * No cache. Errors are deliberately fixed strings, not remote payloads.
 */
export function createPublicRead(options: PublicReadOptions = {}): { read: PublicRead; stats: () => PublicReadStats } {
  const maxRequests = integer(options.maxRequests ?? 40, 200);
  const maxBytes = integer(options.maxBytes ?? 4 * 1024 * 1024, 8 * 1024 * 1024);
  const maxTotalBytes = integer(options.maxTotalBytes ?? 16 * 1024 * 1024, 32 * 1024 * 1024);
  const duration = integer(options.deadlineMs ?? 15000, 60000);
  const deadline = performance.now() + duration;
  const fetcher = options.fetcher ?? fetch;
  let requests = 0, bytes = 0, exhausted = false, active = false;
  const read: PublicRead = async path => {
    if (!allowed(path)) throw new Error('public read path refused');
    // The collector is sequential. Reject accidental concurrency rather than
    // allowing competing streams to overspend the shared byte budget.
    if (active) throw new Error('public read already active');
    const remaining = Math.floor(deadline - performance.now());
    if (exhausted || requests >= maxRequests || bytes >= maxTotalBytes || remaining <= 0 || options.signal?.aborted) {
      exhausted = true; throw new Error('public read budget exhausted');
    }
    const url = new URL(path, ORIGIN);
    if (url.origin !== ORIGIN || url.pathname + url.search !== path) throw new Error('public read path refused');
    active = true;
    requests++;
    const timeout = AbortSignal.timeout(remaining);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      const res = await fetcher(url, { method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
        headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }, signal });
      if (res.status === 403 || res.status === 429) exhausted = true;
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => {});
        throw new Error('public read unavailable');
      }
      if (res.redirected || (res.url && res.url !== url.href)) {
        await res.body.cancel().catch(() => {});
        throw new Error('public read unavailable');
      }
      const length = res.headers.get('content-length');
      const cap = Math.min(maxBytes, maxTotalBytes - bytes);
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > cap)) {
        exhausted = true; await res.body.cancel().catch(() => {}); throw new Error('public read byte budget');
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let size = 0, text = '';
      try {
        for (;;) {
          if (signal.aborted || performance.now() >= deadline) { exhausted = true; throw new Error('public read deadline'); }
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          bytes += part.value.byteLength;
          if (size > cap || bytes > maxTotalBytes) { exhausted = true; throw new Error('public read byte budget'); }
          text += decoder.decode(part.value, { stream: true });
        }
        text += decoder.decode();
        if (signal.aborted || performance.now() >= deadline) { exhausted = true; throw new Error('public read deadline'); }
        return JSON.parse(text) as unknown;
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    } catch {
      if (signal.aborted) exhausted = true;
      throw new Error('public read unavailable');
    } finally { active = false; }
  };
  return { read, stats: () => ({ requests, bytes, exhausted }) };
}
