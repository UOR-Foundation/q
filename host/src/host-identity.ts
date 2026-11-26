// A measured package-file fingerprint, not a signature, revision or runtime attestation.
// The same five input paths are copied into the Docker image. Never scan /data,
// environment, installed dependencies, or arbitrary user-selected paths in production.
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUTS = ['host/src', 'host/web', 'host/package.json', 'host/package-lock.json', 'experiments'] as const;
const MAX_FILES = 4096;
const MAX_BYTES = 64 * 1024 * 1024;
export type HostIdentity = Readonly<{ fingerprint: string; files: number }>;

export function measureHostFiles(root: string): HostIdentity {
  const entries: [string, string][] = [];
  let bytes = 0;
  function visit(relative: string): void {
    const path = join(root, relative);
    const before = lstatSync(path);
    if (before.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(relative + '/' + name);
      return;
    }
    if (!before.isFile() || entries.length >= MAX_FILES || before.size > MAX_BYTES - bytes) throw Error('host package measurement refused');
    const data = readFileSync(path);
    const after = lstatSync(path);
    if (!after.isFile() || before.ino !== after.ino || before.dev !== after.dev ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        data.length !== before.size || data.length > MAX_BYTES - bytes) throw Error('host package changed during measurement');
    bytes += data.length;
    entries.push([relative, createHash('sha256').update(data).digest('hex')]);
  }
  for (const input of INPUTS) {
    const count = entries.length;
    visit(input);
    if (count === entries.length) throw Error('host package input empty');
  }
  entries.sort((a,b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return Object.freeze({fingerprint:'sha256:' + createHash('sha256').update(JSON.stringify(['q-host-files/v1',entries])).digest('hex'),files:entries.length});
}
