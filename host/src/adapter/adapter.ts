// The platform adapter interface, as in LangBot: one per platform, Discord the only one in v1.
// An adapter turns platform events into the facts the pipeline and the memory need, and sends
// back what the pipeline returns in the way the kernel decided. Adding a platform is adding
// an adapter; the kernel, the pipeline and the memory do not change.
import type { Observed } from '../memory.ts';
import type { Incoming, Outgoing } from '../pipeline.ts';

export interface Handlers {
  handle(message: Incoming): Promise<Outgoing | undefined>;
  observe(message: Observed): Promise<'index' | 'skip'>;
  /** A message was deleted or edited: forget what was indexed of it. `before` is the message as it was, when known. */
  withdraw(url: string, before?: Observed): Promise<number>;
  /** A channel or thread was deleted: forget everything indexed from it. */
  forgetChannel(id: string): Promise<number>;
  /** A reaction was added or removed: the kernel decides whether the member role changes. */
  membership(onRules: boolean, human: boolean, added: boolean): Promise<'grant' | 'revoke' | 'none'>;
  /** Q delivered a reply: the improvement loop keeps it, and a refusal becomes a gap (improve.ts). */
  delivered?(d: { questionUrl?: string; sentUrl: string; question: string; channelId: string; authorId: string; reply: Outgoing }): Promise<void>;
  /**
   * A reaction added by a member, on a message Q sent or on any other: the improvement loop decides whether it is a
   * signal (decision 26), an approval that makes a test, a disapproval, or a confirmation of a correction.
   */
  react?(url: string, emoji: string | null, human: boolean, member: string): Promise<string>;
}

export interface Adapter {
  /** Connect and serve: offer every message to the memory, and every invitation to the pipeline. */
  start(handlers: Handlers): Promise<void>;
  /** Offer the history the platform keeps to the memory, resumably. */
  backfill(observe: Handlers['observe']): Promise<void>;
  /** A channel's or thread's name, when the platform knows it: a cited message reads as "#general", not as ids. */
  channelName?(id: string): string | undefined;
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
