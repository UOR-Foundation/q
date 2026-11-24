// The app builder, as its own service: a spec in, a verified app published in its own holospace out.
//
// Why a separate process: proving and building takes tens of seconds and hundreds of megabytes. Run beside Q, a build
// could starve or kill it; here it has its own memory and CPU, builds one app at a time, and Q only waits on a socket.
//
// How: `prism-code init` writes the template, the generator writes the model from the spec (appgen.ts), `prism-code
// build` proves every theorem and replays every vector, `prism-code verify` judges what was built, and the holo goes
// to Filebase. Each step is streamed to the caller as one JSON line, so the person who asked can watch it happen.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkSpec, generate, SpecRefused, type AppSpec } from './appgen.ts';
import { publish, type FilebaseOptions } from './filebase.ts';

export const HOLOSPACE = 'https://hologram-technologies.github.io/holospace-shell/space.html';

export type Stage =
  | { stage: 'scaffold' | 'model' | 'prove' | 'verify' | 'publish' }
  | { stage: 'done'; label: string; cid: string; holo: string; link: string; theorems: number; vectors: string; seconds: number }
  | { stage: 'refused'; reason: string };

const require = createRequire(import.meta.url);
const prismCode = (() => {
  const pkg = require.resolve('prism-code/package.json');
  const { bin } = JSON.parse(require('node:fs').readFileSync(pkg, 'utf8')) as { bin: string | Record<string, string> };
  return join(dirname(pkg), typeof bin === 'string' ? bin : bin['prism-code']);
})();

/** Run prism-code in a folder; its JSON report, or a refusal with its first diagnostics. */
function run(cwd: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; report: Record<string, unknown> | null; text: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [prismCode, ...args], { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      let report: Record<string, unknown> | null = null;
      try { report = JSON.parse(stdout); } catch { /* not JSON */ }
      resolve({ ok: !error, report, text: `${stdout}\n${stderr}` });
    });
  });
}

const firstProblem = (report: Record<string, unknown> | null, text: string) => {
  const d = (report?.diagnostics as { code: string; message: string }[] | undefined)?.[0];
  return d ? `${d.code}: ${d.message}`.slice(0, 300) : text.trim().slice(-300);
};

/** Build one app, telling `say` each stage. Never throws: a failure is a refusal with its reason. */
export async function buildApp(input: AppSpec, filebase: FilebaseOptions, say: (s: Stage) => void, root = tmpdir()): Promise<void> {
  const started = Date.now();
  let work: string | undefined;
  try {
    const spec = checkSpec(input);
    work = await mkdtemp(join(root, 'q-app-'));
    say({ stage: 'scaffold' });
    const init = await run(work, ['init', 'app', '--name', spec.name, '--no-skill'], 60_000);
    if (!init.ok) return say({ stage: 'refused', reason: `scaffold failed: ${firstProblem(init.report, init.text)}` });
    const dir = join(work, 'app');
    say({ stage: 'model' });
    for (const [path, text] of Object.entries(generate(spec))) {
      const full = join(dir, path);
      if (text === null) await rm(full, { force: true });
      else { await mkdir(dirname(full), { recursive: true }); await writeFile(full, text); }
    }
    const toml = join(dir, 'prism.toml');
    await writeFile(toml, (await readFile(toml, 'utf8'))
      .replace(/^name = ".*"$/m, `name = "${spec.name}"`)
      .replace(/^description = ".*"$/m, `description = "${spec.purpose.replace(/["\\\n]/g, ' ').slice(0, 200)}"`));
    say({ stage: 'prove' });
    const built = await run(dir, ['build', '--json'], 240_000);
    if (!built.ok || built.report?.ok !== true) return say({ stage: 'refused', reason: `the proof or the build failed: ${firstProblem(built.report, built.text)}` });
    say({ stage: 'verify' });
    const verified = await run(dir, ['verify', '--json'], 240_000);
    const summary = verified.report?.summary as { address?: string; theoremsVerified?: number; vectorsPassed?: number; vectorsTotal?: number; artifact?: string } | undefined;
    if (!verified.ok || verified.report?.ok !== true || !summary?.address || !summary.artifact) return say({ stage: 'refused', reason: `verification failed: ${firstProblem(verified.report, verified.text)}` });
    say({ stage: 'publish' });
    const bytes = new Uint8Array(await readFile(join(dir, summary.artifact)));
    const { cid, url } = await publish(filebase, `${spec.name}-${summary.address.slice(7, 19)}.holo`, bytes);
    say({
      stage: 'done', label: summary.address, cid, holo: url, link: `${HOLOSPACE}#app=${summary.address}&holo=${url}`,
      theorems: summary.theoremsVerified ?? 0, vectors: `${summary.vectorsPassed}/${summary.vectorsTotal}`, seconds: Math.round((Date.now() - started) / 1000),
    });
  } catch (error) {
    say({ stage: 'refused', reason: error instanceof SpecRefused ? `the spec: ${error.message}` : String(error).slice(0, 300) });
  } finally {
    if (work) await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/** The service: POST /build with a spec, answered with one JSON line per stage. One build at a time. */
export function serve(port: number, filebase: FilebaseOptions) {
  let queue: Promise<void> = Promise.resolve();
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== 'POST' || request.url !== '/build') { response.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    let spec: AppSpec;
    try { spec = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { response.writeHead(400).end(); return; }
    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    const say = (s: Stage) => response.write(`${JSON.stringify(s)}\n`);
    const mine = queue.then(() => buildApp(spec, filebase, say));
    queue = mine.catch(() => {});
    await mine;
    response.end();
  });
  server.listen(port);
  return server;
}

/** Ask a builder service for an app, hearing each stage as it happens. */
export async function requestBuild(url: string, spec: AppSpec, onStage: (s: Stage) => void): Promise<Stage> {
  const response = await fetch(`${url.replace(/\/$/, '')}/build`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(spec) });
  if (!response.ok || !response.body) return { stage: 'refused', reason: `the builder answered ${response.status}` };
  let last: Stage = { stage: 'refused', reason: 'the builder said nothing' };
  let buffer = '';
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      last = JSON.parse(line) as Stage;
      onStage(last);
    }
  }
  return last;
}
