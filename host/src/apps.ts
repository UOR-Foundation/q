// A person's one prompt, made into an app spec by the language model, checked, and sent to the builder service.
// The model writes only a small decision table (appgen.ts says what one is); a spec the generator refuses goes back to
// the model once, with the reason, before Q gives up and says why.
import { checkSpec, SpecRefused, type AppSpec } from './appgen.ts';
import type { Llm } from './providers.ts';

export const SPEC_PROMPT = `You design a small decision app from a person's request. The app reads a few typed words and answers with one of a fixed set of outcomes. Reply with exactly one JSON object and nothing else, in this shape:

{"name":"tip-advisor","title":"Tip advisor","purpose":"Suggest a tip from how the service was and how large the party is.",
 "fields":[{"name":"service","values":["poor","ok","great"]},{"name":"party","values":["small","large"]}],
 "outcomes":["10%","15%","18%","20%"],
 "rules":[{"when":{"service":"poor"},"then":"10%"},{"when":{"service":"great","party":"large"},"then":"20%"},{"when":{"service":"great"},"then":"18%"},{"when":{},"then":"15%"}]}

Rules for the object:
- name: a lowercase slug, 2 to 40 characters. title: a few words. purpose: one sentence.
- fields: 1 to 4, each a lowercase word naming what the person types, with 2 to 8 values, each a short lowercase word or hyphenated word.
- outcomes: 2 to 12 distinct short answers, each at most 80 characters, never "invalid".
- rules: checked in order, the first that matches answers. A rule's "when" names a value for some fields. The last rule's "when" is {} and is the default. Every "then" is one of the outcomes.
- If the request cannot be a small decision table (it needs free text, arithmetic on numbers, memory, or the network), make the closest useful decision table anyway and say what it decides in the purpose.`;

/** The model's reply, as JSON: the first object in it. */
function parse(reply: string): AppSpec {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) throw new SpecRefused('the reply held no JSON object');
  try {
    return JSON.parse(reply.slice(start, end + 1)) as AppSpec;
  } catch {
    throw new SpecRefused('the reply was not valid JSON');
  }
}

/** Design a checked spec from a prompt: one try, and one more with the reason the first was refused. */
export async function designSpec(llm: Llm, prompt: string): Promise<AppSpec> {
  const ask = `Request: ${prompt.slice(0, 1500)}`;
  try {
    return checkSpec(parse(await llm.complete(SPEC_PROMPT, ask)));
  } catch (first) {
    if (!(first instanceof SpecRefused)) throw first;
    return checkSpec(parse(await llm.complete(SPEC_PROMPT, `${ask}\n\nYour last answer was refused: ${first.message}. Answer again with one valid JSON object.`)));
  }
}

/** How to use an app, from its spec: what to type, with an example. */
export function usage(spec: AppSpec): string {
  const example = spec.fields.map((f) => f.values[f.values.length - 1]).join(' ');
  return `Type ${spec.fields.map((f) => `**${f.name}** (${f.values.join(', ')})`).join(', then ')}. For example: \`${example}\``;
}
