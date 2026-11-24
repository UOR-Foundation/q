// The website's adapter: Q over HTTP, for a browser on uor.foundation. Like every adapter it turns
// platform events into facts and sends back what the pipeline returns; it holds no policy. Every
// question runs the same pipeline on the `web` surface, where the kernel withholds every private
// item (decision 17), so nothing from Discord is ever served here.
//
//   GET  /manifest       what every answer here depends on besides the question, and the suggested questions
//   GET  /answer/<key>   the answer already computed for a question key: no question text is sent
//   GET  /item/<label>   one public source, so a visitor can recompute the label an answer cites
//   GET  /kernel/<label> the kernel this host runs, as bytes, when that is its label
//   POST /ask            one question; the answer's stages as server-sent events
//
// A browser computes the question key itself (records.ts questionKey), so a repeat costs one
// round trip and the question never leaves the page.
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isLabel } from '../address.ts';
import type { Pipeline, Progress } from '../pipeline.ts';
import { Gate } from '../providers.ts';
import { questionKey } from '../records.ts';

export interface WebOptions {
  /** The origins a browser may call from. A request from any other origin is refused. */
  origins: readonly string[];
  /** Questions offered to a visitor. Their answers, once computed, are sent with the manifest. */
  suggestions: readonly string[];
  /** Questions from the website worked on at once. One leaves the model's other slot to Discord. */
  concurrency: number;
  /** Questions that may wait for a turn; past that a visitor is told Q is busy. */
  queue?: number;
  /** The kernel this host runs, by label and as bytes, so a browser can run the same one and check its label. */
  kernel: { label: string; bytes: Uint8Array };
  /** True behind a reverse proxy that sets X-Forwarded-For: the visitor is the last address it names. */
  trustProxy?: boolean;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

/** The longest question the website takes: what retrieval reads, so the key covers all of it. */
export const QUESTION_LIMIT = 1000;
const BODY_LIMIT = 8192;

export function webServer(pipeline: Pipeline, options: WebOptions): Server {
  const gate = new Gate(options.concurrency);
  const queue = options.queue ?? 8;
  let waiting = 0;
  // A visitor is known only as a salted hash of an address, for the rate limit and for one question at
  // a time. The salt is made at start and never stored, so the hash names nobody once the process ends.
  const salt = randomBytes(16);
  const visitor = (request: IncomingMessage) => {
    const forwarded = options.trustProxy ? String(request.headers['x-forwarded-for'] ?? '').split(',').at(-1)?.trim() : '';
    return createHash('sha256').update(salt).update(forwarded || request.socket.remoteAddress || '').digest('hex').slice(0, 16);
  };

  const json = (response: ServerResponse, status: number, body: unknown, cache = 'no-store') => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache });
    response.end(JSON.stringify(body));
  };

  async function manifest(response: ServerResponse) {
    const { label, manifest } = await pipeline.manifest();
    const suggestions = options.suggestions.map((question) => ({ question, key: questionKey(question, label) }));
    const answers: Record<string, unknown> = {};
    for (const { key } of suggestions) {
      const known = await pipeline.lookup(key);
      if (known) answers[key] = known;
    }
    json(response, 200, { label, manifest, suggestions, answers, limits: { question: QUESTION_LIMIT } }, 'public, max-age=30');
  }

  async function read(request: IncomingMessage): Promise<string | undefined> {
    const parts: Buffer[] = [];
    let size = 0;
    for await (const part of request) {
      size += part.length;
      if (size > BODY_LIMIT) return undefined;
      parts.push(part);
    }
    return Buffer.concat(parts).toString('utf8');
  }

  async function ask(request: IncomingMessage, response: ServerResponse) {
    const body = await read(request);
    let question: unknown;
    try {
      question = body === undefined ? undefined : (JSON.parse(body) as { question?: unknown }).question;
    } catch {
      question = undefined;
    }
    if (typeof question !== 'string') return json(response, 400, { error: 'send {"question": "..."} of at most 8 KB' });
    if (question.length > QUESTION_LIMIT) return json(response, 400, { error: `a question is at most ${QUESTION_LIMIT} characters` });
    if (waiting >= queue) return json(response, 503, { error: 'Q is busy. Try again in a moment.' });

    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    const send = (event: string, data: unknown) => { if (!response.writableEnded) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    const started = performance.now();
    const author = `web:${visitor(request)}`;
    waiting++;
    send('queued', { ahead: waiting - 1 });
    try {
      const reply = await gate.run(() => {
        waiting--;
        return pipeline.handle({
          surface: 'web', channelId: 'web', authorId: author, role: 'member', trigger: 'slash', command: 'ask', text: question,
          working: () => send('decided', {}),
          progress: (stage: Progress) => (stage.stage === 'sources' ? send('sources', { outcome: stage.outcome, sources: stage.sources }) : send('text', { delta: stage.delta })),
        });
      });
      const ms = Math.round(performance.now() - started);
      if (reply?.web) send('answer', { ...reply.web, timings: reply.timings ?? {}, ms });
      // A turn the kernel stopped before retrieval: rate limited, filtered, or not answered at all.
      else send('refused', { decision: reply?.decision ?? 'silent', text: reply?.text ?? '', ms });
      options.log?.('web-reply', { decision: reply?.decision ?? 'silent', ms, timings: reply?.timings });
    } catch (error) {
      options.log?.('web-failed', { message: String(error) });
      send('failed', { text: 'Something went wrong while answering. Try again.' });
    }
    response.end();
  }

  return createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://q');
    const origin = request.headers.origin;
    const allowed = origin !== undefined && options.origins.includes(origin);
    if (allowed) {
      response.setHeader('access-control-allow-origin', origin);
      response.setHeader('vary', 'Origin');
    }
    // A browser on another site is refused. A request with no Origin is not from a page.
    if (origin !== undefined && !allowed) return json(response, 403, { error: 'this origin may not ask Q' });
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' });
      return response.end();
    }
    const route = async () => {
      if (request.method === 'GET' && url.pathname === '/manifest') return manifest(response);
      if (request.method === 'GET' && url.pathname.startsWith('/answer/')) {
        const key = decodeURIComponent(url.pathname.slice('/answer/'.length));
        const known = isLabel(key) ? await pipeline.lookup(key) : undefined;
        return known ? json(response, 200, known, 'public, max-age=300') : json(response, 404, { error: 'no answer is computed for this key' });
      }
      if (request.method === 'GET' && url.pathname.startsWith('/item/')) {
        const label = decodeURIComponent(url.pathname.slice('/item/'.length));
        const item = isLabel(label) ? await pipeline.item(label) : undefined;
        return item ? json(response, 200, item, 'public, max-age=86400, immutable') : json(response, 404, { error: 'no public item has this label' });
      }
      if (request.method === 'GET' && url.pathname === `/kernel/${options.kernel.label}`) {
        // Named by its label, these bytes never change.
        response.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable' });
        return response.end(options.kernel.bytes);
      }
      if (request.method === 'POST' && url.pathname === '/ask') return ask(request, response);
      if (request.method === 'GET' && url.pathname === '/healthz') return json(response, 200, { ok: true });
      return json(response, 404, { error: 'not found' });
    };
    route().catch((error) => {
      options.log?.('web-failed', { message: String(error) });
      if (!response.headersSent) json(response, 500, { error: 'failed' });
      else response.end();
    });
  });
}
