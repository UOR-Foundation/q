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
import type { Level } from './kernel.ts';

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
  request: { command: string; trigger: string; surface: 'discord' | 'mcp'; question: string };
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
