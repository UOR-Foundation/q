// Q's input and output, as records. Every question Q answers or refuses is one turn,
// and every turn leaves exactly these three, schemas in docs/schemas/:
//
//   in   uor-agent/context/1   everything the answer was made from: the question, the kernel,
//                              the community pin, what retrieval found, the decision asked
//   out  uor-agent/answer/1    what Q said, naming its context, its evidence and its claim level
//   out  CloudEvents 1.0       counts only, safe to publish: no text, no author, no label of either
//
// The two records are stored items, named by their BLAKE3 kappa labels and linked with the
// Kappa Registry's relations. Both carry a person's question, so both live in the private
// namespace and are forgotten with their author. Replaying a turn needs only its context label.
import { labelOf, type Item } from './address.ts';
import type { CommunityPin } from './community.ts';
import type { Level, SourceName, Surface } from './kernel.ts';

export const CONTEXT_SCHEMA = 'uor-agent/context/1';
export const ANSWER_SCHEMA = 'uor-agent/answer/1';
export const EVENT_TYPE = 'org.uorfoundation.discord.answer';
export const EVENT_SOURCE = 'https://github.com/UOR-Foundation/q';

export interface DecisionAsked {
  /** The community app, by name. */
  app: string;
  /** Its inputs, field by field, as Q read them from the question: interpretation, not fact. */
  inputs: Record<string, string>;
  /** Fields the question did not settle. The holo is asked only when this is empty. */
  missing: string[];
  /** What the community holo answered, or null when inputs were missing and it was not asked. */
  answer: string | null;
}

export interface ContextFields {
  kernel: { holo: string; model: string; commit: string | null };
  community: { holo: string; commit: string };
  request: { command: string; trigger: string; surface: Surface; question: string };
  retrieval: { band: 'low' | 'medium' | 'high'; items: string[] };
  /** The earlier answers this question builds on, by label: a reply to Q, admitted turn by turn by the kernel. */
  history: string[];
  decision: DecisionAsked | null;
  author: string;
  channel: string;
  created: number;
}

export interface AnswerFields {
  /** The kappa label of the context this answer was made from. */
  context: string;
  outcome: 'answer' | 'answer with notice' | 'not grounded';
  level: Level | null;
  text: string;
  citations: string[];
  /** Every MCP tool call the language model asked for, in order, with the kernel's decision on it. */
  tools: ToolUse[];
  /**
   * The answer key: the BLAKE3 label of everything this answer depends on (the question, Q's kernel, the
   * community pin, the evidence, the prompt and the model). Null when it may not be reused: a refusal,
   * a search, or an answer that called a tool.
   */
  memo: string | null;
  /** The answer this one reused, computed once for the same key; null when it was computed now. */
  reused: string | null;
  author: string;
  channel: string;
  created: number;
}

/** One MCP tool call: the kernel's decision, and the label of the stored result when it ran. */
export interface ToolUse { server: string; tool: string; decision: 'call' | 'refuse'; result: string | null }

export interface CloudEvent {
  specversion: '1.0';
  type: typeof EVENT_TYPE;
  source: typeof EVENT_SOURCE;
  /** The kappa label of this event's own content, so the same turn outcome always has the same id. */
  id: string;
  time: string;
  datacontenttype: 'application/json';
  data: { outcome: Answer['outcome']; level: Level | null; citations: number; tools: number; reused: boolean; decision: string | null; kernel: string; community: string };
}

export type Context = Item & ContextFields & { type: 'context'; schema: typeof CONTEXT_SCHEMA };
export type Answer = Item & AnswerFields & { type: 'answer'; schema: typeof ANSWER_SCHEMA };

export function context(fields: ContextFields): Context {
  return { type: 'context', schema: CONTEXT_SCHEMA, ...fields };
}

export function answer(fields: AnswerFields): Answer {
  return { type: 'answer', schema: ANSWER_SCHEMA, ...fields };
}

/** The public trace of one turn. It names the app a decision came from, never the inputs or the answer text. */
export function event(turn: Context, said: Answer): CloudEvent {
  const time = new Date(said.created).toISOString();
  const data: CloudEvent['data'] = {
    outcome: said.outcome, level: said.level, citations: said.citations.length, tools: said.tools.length, reused: said.reused !== null,
    decision: turn.decision?.app ?? null, kernel: turn.kernel.holo, community: turn.community.holo,
  };
  const id = labelOf({ type: 'event', eventType: EVENT_TYPE, time, data });
  return { specversion: '1.0', type: EVENT_TYPE, source: EVENT_SOURCE, id, time, datacontenttype: 'application/json', data };
}

export const pinOf = (pin: CommunityPin) => ({ holo: pin.holo, commit: pin.commit });

// The website's two records. Unlike a turn's records they are public: they hold no question,
// no author and no time, and no label of a turn's records. A browser can compute both labels.
//
//   uor-agent/web-manifest/1   everything an answer on the website depends on besides the question
//   uor-agent/web-answer/1     one answer as the website is given it, named by its question key

export const MANIFEST_SCHEMA = 'uor-agent/web-manifest/1';
export const WEB_ANSWER_SCHEMA = 'uor-agent/web-answer/1';

export interface ManifestFields {
  kernel: { holo: string; commit: string | null };
  community: { holo: string; commit: string };
  /** The BLAKE3 label of the sorted labels of every chunk the kernel serves on the website: the index, as one name. */
  corpus: string;
  /** The label of the prompts. */
  prompt: string;
  /** The language model, by the name its provider gives it. */
  model: string;
  /** What retrieval was run with. The similarities are strings: a label is canonical only over integers and strings. */
  retrieval: { embedder: string; retrieve: number; medium: string; high: string };
}
export type Manifest = Item & ManifestFields & { type: 'web-manifest'; schema: typeof MANIFEST_SCHEMA };

export function manifest(fields: ManifestFields): Manifest {
  return { type: 'web-manifest', schema: MANIFEST_SCHEMA, ...fields };
}

/** A question as its keys read it: the same words, whatever the case or spacing. A browser does exactly this. */
export const normalize = (text: string) => text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * The question key: the BLAKE3 label of a question and the manifest it is asked under. On the website an
 * answer has no history, so the same key is the same computation, and a browser can name it without asking.
 */
export const questionKey = (question: string, manifestLabel: string) => labelOf({ type: 'web-question', question: normalize(question), manifest: manifestLabel });

/** One source of a website answer: a public item by its label, and whether the answer cites it. */
export interface WebSource { n: number; label: string; url: string; source: SourceName; level: Level; cited: boolean }

export interface WebAnswerFields {
  /** The question key this answers. */
  key: string;
  /** The label of the manifest it was computed under. */
  manifest: string;
  outcome: Answer['outcome'];
  /** The score band the kernel was told: with the number of sources, what the grounding decision was made from. */
  band: 'low' | 'medium' | 'high';
  /** The claim level, or null when nothing is claimed: a refusal, or sources that do not answer. */
  level: Level | null;
  text: string;
  /** A community decision the answer states, and the community commit it was proved in. */
  decision: { app: string; answer: string; commit: string } | null;
  /** Every source the answer was written from, most trusted first. Empty when nothing is claimed. */
  sources: WebSource[];
  /** How many tool calls the answer used. An answer that used one is open at most, and is never reused. */
  tools: number;
  kernel: string;
  community: string;
}
export type WebAnswer = Item & WebAnswerFields & { type: 'web-answer'; schema: typeof WEB_ANSWER_SCHEMA };

export function webAnswer(fields: WebAnswerFields): WebAnswer {
  return { type: 'web-answer', schema: WEB_ANSWER_SCHEMA, ...fields };
}
