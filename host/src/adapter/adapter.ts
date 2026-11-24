// The platform adapter interface, as in LangBot: one per platform, Discord the only one in v1.
// An adapter turns platform events into the facts the pipeline and the memory need, and sends
// back what the pipeline returns in the way the kernel decided. Adding a platform is adding
// an adapter; the kernel, the pipeline and the memory do not change.
import type { Observed } from '../memory.ts';
import type { Incoming, Outgoing } from '../pipeline.ts';

export interface Handlers {
  handle(message: Incoming): Promise<Outgoing | undefined>;
  observe(message: Observed): Promise<'index' | 'skip'>;
}

export interface Adapter {
  /** Connect and serve: offer every message to the memory, and every invitation to the pipeline. */
  start(handlers: Handlers): Promise<void>;
  /** Offer the history the platform keeps to the memory, resumably. */
  backfill(observe: Handlers['observe']): Promise<void>;
}

/** One message to send: text, and a file when the kernel decided the reply goes as one. */
export interface Payload { content: string; file?: { name: string; text: string } }

/** A reply as the messages that carry it, under a platform's limit per message. */
export function payloads(reply: Outgoing, limit: number): Payload[] {
  if (reply.delivery === 'file') {
    return [{ content: 'The answer is longer than a few messages, so it is attached.', file: { name: 'answer.md', text: reply.text } }];
  }
  if (reply.delivery === 'send') return [{ content: reply.text }];
  const room = limit - 100;
  return (reply.text.match(new RegExp(`[\\s\\S]{1,${room}}(?=\\n|$)|[\\s\\S]{1,${room}}`, 'g')) ?? [reply.text]).map((content) => ({ content }));
}
