// The website's adapter: Q over HTTP, for a browser on uor.foundation and for any other agent. Like
// every adapter it turns platform events into facts and sends back what the pipeline returns; it holds
// no policy. Every question runs the same pipeline on the `web` surface (`mcp` at /mcp), where the
// kernel withholds every private item (decision 17), so nothing from Discord is ever served here.
//
//   GET  /               how to ask, as Markdown: what an agent reads first
//   GET  /ask?q=...      one question answered whole: Markdown, or the record when JSON is accepted
//   POST /ask            one question; its stages as server-sent events, or whole when JSON or Markdown is accepted
//   POST /mcp            Q's MCP server (mcp-server.ts) over Streamable HTTP, one request at a time
//   GET  /manifest       what every answer here depends on besides the question, and the suggested questions
//   GET  /answer/<key>   the answer already computed for a question key: no question text is sent
//   GET  /item/<label>   one public source, so a visitor can recompute the label an answer cites
//   GET  /kernel/<label> the kernel this host runs, as bytes, when that is its label
//
// A browser computes the question key itself (records.ts questionKey), so a repeat costs one
// round trip and the question never leaves the page.
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isLabel } from '../address.ts';
import type { Incoming, Pipeline, Progress, Published } from '../pipeline.ts';
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
  /** Q's MCP server for one caller, served at /mcp. Without it /mcp is not found. */
  mcp?: (asker: Pick<Pipeline, 'handle'>, author: string) => McpServer;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

/** The longest question the website takes: what retrieval reads, so the key covers all of it. */
export const QUESTION_LIMIT = 1000;
const BODY_LIMIT = 8192;
const BUSY = 'Q is busy. Try again in a moment.';
const REPOSITORY = 'https://github.com/UOR-Foundation/q';
const FENCE = '```';

/** How to ask Q, for an agent that has only this address: served at / and /llms.txt. */
export function manual(base: string, mcp: boolean): string {
  const connect = [
    '## Connect Q as a tool', '',
    'Q is an MCP server over Streamable HTTP, with no sign-in:', '',
    `${FENCE}json`, `{ "mcpServers": { "q": { "type": "http", "url": "${base}/mcp" } } }`, FENCE, '',
    'Tools: `ask`, `search`, `status`, `community_apps`, `community_decide`.', '',
  ];
  return [
    '# Q', '',
    "> Q is the UOR Foundation's agent. Ask it about UOR, Prism, LexLean and the Foundation. It answers from the Foundation's public sources, cites each one by its content address, and says how sure it is.", '',
    '## Ask', '',
    'One request. No key, no account.', '',
    FENCE, `GET ${base}/ask?q=What+is+a+holo%3F`, FENCE, '',
    'The answer is Markdown: the text, its numbered sources, the claim level. Send `Accept: application/json` for the answer record instead.', '',
    'To keep a question out of the URL, post it:', '',
    `${FENCE}sh`, `curl -s ${base}/ask -H 'Accept: application/json' -d '{"question": "What is a holo?"}'`, FENCE, '',
    'A post that accepts neither JSON nor Markdown streams the answer as server-sent events: `queued`, `decided`, `sources`, `text`, `answer`.', '',
    ...(mcp ? connect : []),
    '## What to expect', '',
    `- A question is at most ${QUESTION_LIMIT} characters.`,
    '- A new answer takes 10 to 15 seconds. The same question again is read back in milliseconds.',
    '- Each caller may ask a few questions a minute. Past that the status is 429; when Q is busy it is 503. Wait and ask again.',
    "- Claim levels: `build` is built and checked, `some-true` comes from the Foundation's community model, website or repository files, `open` is not established (an issue, or an answer that called a tool). When the sources do not answer, Q says so instead of guessing.",
    "- Public sources only. Nothing from Discord is served here, a rule proved in Q's kernel.",
    "- A new question is kept to reuse its answer, without the caller's name or address. Put nothing private in one.", '',
    '## Check an answer', '',
    'Every answer names its sources by BLAKE3 content address, so none of this rests on trusting the host.', '',
    `- \`GET ${base}/answer/<question key>\`: an answer already computed, with no question sent.`,
    `- \`GET ${base}/item/<label>\`: one source as stored, so its label can be recomputed.`,
    `- \`GET ${base}/manifest\`: the kernel, sources and model every answer depends on.`,
    `- \`GET ${base}/kernel/<label>\`: the signed decision kernel Q runs, to run the same decisions yourself.`, '',
    `Protocol and proofs: ${REPOSITORY}/blob/main/docs/web.md`, '',
  ].join('\n');
}

/** An answer as a page an agent reads: the text, each source by address, and what the kernel decided. */
export function answerPage({ label, answer }: Published, base: string): string {
  const count = answer.sources.length;
  // Headed section by section: a reader that skims, or a small model summarising, must not mistake the answer for a preamble.
  return [
    "# Q's answer", '',
    answer.text, '',
    ...(count ? ['## Sources', '', ...answer.sources.map((s) => `${s.n}. ${s.url} (${s.source}, ${s.level}${s.cited ? ', cited' : ''}) \`${s.label}\``), ''] : []),
    '## How far it is established', '',
    ...(answer.decision ? [`Community decision: ${answer.decision.app} answered ${answer.decision.answer}, at commit ${answer.decision.commit}.`, ''] : []),
    `Claim level: ${answer.level ?? 'none'}. Grounding: ${answer.outcome}, from the ${answer.band} band and ${count} source${count === 1 ? '' : 's'}.`, '',
    '## Check it', '',
    `- The record of this answer has the label \`${label}\`.`,
    `- Read it again, with no question sent: ${base}/answer/${answer.key}`,
    `- How to check it yourself: ${base}/`, '',
  ].join('\n');
}

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
  const markdown = (response: ServerResponse, status: number, body: string, cache = 'no-store') => {
    response.writeHead(status, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': cache });
    response.end(body);
  };
  /** This host as the caller reached it, for the addresses the manual and an answer's page give. */
  const base = (request: IncomingMessage) => {
    const scheme = options.trustProxy ? String(request.headers['x-forwarded-proto'] ?? 'https').split(',')[0].trim() : 'http';
    return `${scheme}://${request.headers.host ?? 'localhost'}`;
  };
  /** What the caller reads: an agent's fetch takes a page or a record, a browser's stream takes events. */
  const wants = (request: IncomingMessage): 'json' | 'markdown' | 'events' => {
    const accept = String(request.headers.accept ?? '');
    if (accept.includes('application/json')) return 'json';
    return request.method === 'GET' || accept.includes('text/markdown') ? 'markdown' : 'events';
  };
  /** The line questions wait in: `concurrency` worked on at once. A caller checks it is not full before joining. */
  const full = () => waiting >= queue;
  const inLine = <T>(work: () => Promise<T>): Promise<T> => {
    waiting++;
    return gate.run(() => {
      waiting--;
      return work();
    });
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

  const turn = (request: IncomingMessage, question: string, stages: Pick<Incoming, 'working' | 'progress'> = {}) => pipeline.handle({
    surface: 'web', channelId: 'web', authorId: `web:${visitor(request)}`, role: 'member', trigger: 'slash', command: 'ask', text: question, ...stages,
  });

  /** One question: in the body of a POST, or given by a GET's `q`. */
  async function ask(request: IncomingMessage, response: ServerResponse, given?: string | null) {
    const as = wants(request);
    const refuse = (status: number, error: string) => (as === 'markdown' ? markdown(response, status, `${error}\n`) : json(response, status, { error }));
    let question: unknown = given;
    if (request.method === 'POST') {
      const body = await read(request);
      try {
        question = body === undefined ? undefined : (JSON.parse(body) as { question?: unknown }).question;
      } catch {
        question = undefined;
      }
    }
    if (typeof question !== 'string' || !question.trim()) return refuse(400, request.method === 'POST' ? 'send {"question": "..."} of at most 8 KB' : `ask with ?q=, as in ${base(request)}/ask?q=What+is+a+holo%3F`);
    if (question.length > QUESTION_LIMIT) return refuse(400, `a question is at most ${QUESTION_LIMIT} characters`);
    if (full()) return refuse(503, BUSY);
    if (as !== 'events') return whole(request, response, question, as);

    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    const send = (event: string, data: unknown) => { if (!response.writableEnded) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    const started = performance.now();
    send('queued', { ahead: waiting });
    try {
      const reply = await inLine(() => turn(request, question, {
        working: () => send('decided', {}),
        progress: (stage: Progress) => (stage.stage === 'sources' ? send('sources', { outcome: stage.outcome, sources: stage.sources }) : send('text', { delta: stage.delta })),
      }));
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

  /** One question answered in one response, for a caller that does not read a stream. */
  async function whole(request: IncomingMessage, response: ServerResponse, question: string, as: 'json' | 'markdown') {
    const started = performance.now();
    const reply = await inLine(() => turn(request, question));
    const decision = reply?.decision ?? 'silent';
    options.log?.('web-reply', { decision, ms: Math.round(performance.now() - started), timings: reply?.timings, as });
    if (reply?.web) return as === 'json' ? json(response, 200, reply.web) : markdown(response, 200, answerPage(reply.web, base(request)));
    // A turn the kernel stopped before retrieval: rate limited, filtered, or not answered at all.
    const status = decision === 'rate limited' ? 429 : 422;
    return as === 'json' ? json(response, status, { refused: decision, text: reply?.text ?? '' }) : markdown(response, status, `${reply?.text || `Q did not answer: ${decision}.`}\n`);
  }

  /** Q's MCP server for this one request. Nothing is kept between requests, so a client needs no session. */
  async function mcp(request: IncomingMessage, response: ServerResponse) {
    const rpc = (status: number, code: number, message: string) => json(response, status, { jsonrpc: '2.0', error: { code, message }, id: null });
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      return rpc(405, -32000, 'Send each MCP message as a POST. This server keeps no session and opens no stream.');
    }
    const body = await read(request);
    let message: unknown;
    try {
      message = JSON.parse(body ?? '');
    } catch {
      return rpc(400, -32700, 'The body is not JSON, or is over 8 KB.');
    }
    // A question waits in the same line as the website's, so Discord keeps its model slot. A search calls no model.
    const asker: Pick<Pipeline, 'handle'> = {
      handle: async (incoming) => {
        if (incoming.command !== 'ask') return pipeline.handle(incoming);
        if (full()) throw new Error(BUSY);
        return inLine(() => pipeline.handle(incoming));
      },
    };
    const server = options.mcp!(asker, `mcp:${visitor(request)}`);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(request, response, message);
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
      if (request.method === 'GET' && url.pathname === '/ask') return ask(request, response, url.searchParams.get('q') ?? url.searchParams.get('question'));
      if (url.pathname === '/mcp' && options.mcp) return mcp(request, response);
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/llms.txt')) return markdown(response, 200, manual(base(request), options.mcp !== undefined), 'public, max-age=300');
      if (request.method === 'GET' && url.pathname === '/healthz') return json(response, 200, { ok: true });
      return json(response, 404, { error: 'not found', manual: `${base(request)}/` });
    };
    route().catch((error) => {
      options.log?.('web-failed', { message: String(error) });
      if (!response.headersSent) json(response, 500, { error: 'failed' });
      else response.end();
    });
  });
}
