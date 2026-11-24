// Filebase, an IPFS pinning service with an S3-compatible API: where the apps Q builds are published. An object put
// in an IPFS bucket comes back with its CID, and any gateway serves it by that CID. The holospace page fetches it from
// the gateway and checks it against the app's BLAKE3 label before anything runs, so the gateway is trusted for
// nothing but availability. Signed with AWS Signature V4; the keys come from the environment and are never logged.
import { createHash, createHmac } from 'node:crypto';

export interface FilebaseOptions { accessKey: string; secret: string; bucket: string; gateway: string; endpoint?: string }

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Uint8Array | string, data: string) => createHmac('sha256', key).update(data).digest();

/** One signed S3 request. */
export function signed(options: FilebaseOptions, method: string, path: string, body: Uint8Array = new Uint8Array(), now = new Date()) {
  const url = new URL(path, options.endpoint ?? 'https://s3.filebase.com');
  const region = 'us-east-1';
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const payloadHash = sha256(body);
  const headers: Record<string, string> = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const names = Object.keys(headers).sort();
  const canonical = [method, url.pathname, url.searchParams.toString(), names.map((h) => `${h}:${headers[h]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`;
  const key = hmac(hmac(hmac(hmac(`AWS4${options.secret}`, day), region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', key).update(['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n')).digest('hex');
  return { url, headers: { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${options.accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` } };
}

/** Publish bytes under a name in the bucket; returns the CID and a gateway URL that serves them. */
export async function publish(options: FilebaseOptions, name: string, bytes: Uint8Array): Promise<{ cid: string; url: string }> {
  const { url, headers } = signed(options, 'PUT', `/${options.bucket}/${encodeURIComponent(name)}`, bytes);
  const response = await fetch(url, { method: 'PUT', headers, body: Buffer.from(bytes) });
  if (!response.ok) throw new Error(`filebase: ${response.status} ${(await response.text()).slice(0, 200)}`);
  const cid = response.headers.get('x-amz-meta-cid');
  if (!cid) throw new Error('filebase: no CID in the response');
  return { cid, url: `${options.gateway.replace(/\/?$/, '/')}${cid}` };
}
