// Q's app generator: one small spec (a decision table over typed words) becomes a complete Prism app for
// prism-code's own template, which prism-code then checks, proves, builds and verifies.
//
// Why a spec and not free LexLean: a language model writes a short table reliably and LexLean unreliably. The table
// is checked here first, with typed refusals; everything after it is deterministic, so a valid table always builds.
//
// What the app proves (Lean's kernel, at build): every answer is one of the declared outcomes, and every rule decides
// its own outcome whenever it is the first rule to match. Its acceptance vectors are every combination of inputs (up
// to 128), each answered as the table says, computed here from the spec, so the build passes only when the model and
// the spec agree on every input, and a few malformed requests, each answered "invalid".

export interface AppSpec {
  /** A slug: the app's name and its holo's file name. */
  name: string;
  title: string;
  purpose: string;
  /** What the person types, in order, separated by spaces: one word per field. */
  fields: { name: string; values: string[] }[];
  outcomes: string[];
  /** First match wins. A rule names a value for some fields; the last rule names none and is the default. */
  rules: { when: Record<string, string>; then: string }[];
}

export class SpecRefused extends Error {}

const WORD = /^[a-z0-9][a-z0-9-]{0,23}$/;
const SLUG = /^[a-z][a-z0-9-]{1,39}$/;
const hex = (text: string) => '0x' + Buffer.from(text, 'utf8').toString('hex');
/** Text inside a LexLean string literal: printable, with no quote or backslash. */
const plain = (text: string, max: number) => text.replace(/[\\"\n\r\t]/g, ' ').replace(/[^\x20-\x7e]/g, '').trim().slice(0, max);

/** Refuse a spec that would not make a sound app, saying why. */
export function checkSpec(spec: AppSpec): AppSpec {
  const fail = (why: string) => { throw new SpecRefused(why); };
  if (!SLUG.test(spec.name ?? '')) fail('name must be a lowercase slug of 2 to 40 letters, digits and hyphens');
  if (!spec.title?.trim() || !spec.purpose?.trim()) fail('title and purpose are required');
  if (!Array.isArray(spec.fields) || spec.fields.length < 1 || spec.fields.length > 4) fail('between 1 and 4 fields');
  const names = new Set<string>();
  for (const f of spec.fields) {
    if (!WORD.test(f.name ?? '') || names.has(f.name)) fail(`field names must be distinct lowercase words: ${f.name}`);
    names.add(f.name);
    if (!Array.isArray(f.values) || f.values.length < 2 || f.values.length > 8) fail(`field ${f.name} needs 2 to 8 values`);
    if (new Set(f.values).size !== f.values.length || !f.values.every((v) => WORD.test(v))) fail(`field ${f.name}: values must be distinct lowercase words`);
  }
  if (!Array.isArray(spec.outcomes) || spec.outcomes.length < 2 || spec.outcomes.length > 12) fail('between 2 and 12 outcomes');
  if (new Set(spec.outcomes).size !== spec.outcomes.length || spec.outcomes.some((o) => !o.trim() || o.length > 80 || o.trim() === 'invalid')) fail('outcomes must be distinct, non-empty, at most 80 characters, and not "invalid"');
  if (!Array.isArray(spec.rules) || spec.rules.length < 1 || spec.rules.length > 24) fail('between 1 and 24 rules');
  for (const [i, r] of spec.rules.entries()) {
    if (!spec.outcomes.includes(r.then)) fail(`rule ${i + 1} answers "${r.then}", which is not a declared outcome`);
    for (const [field, value] of Object.entries(r.when ?? {})) {
      const f = spec.fields.find((x) => x.name === field);
      if (!f) fail(`rule ${i + 1} names an unknown field: ${field}`);
      if (!f!.values.includes(value)) fail(`rule ${i + 1}: ${value} is not a value of ${field}`);
    }
  }
  if (Object.keys(spec.rules.at(-1)!.when ?? {}).length !== 0) fail('the last rule must name no field: it is the default');
  return spec;
}

/** The table's answer to one request, as the app must give it: first match wins. */
export function decide(spec: AppSpec, values: string[]): string {
  const rule = spec.rules.find((r) => Object.entries(r.when ?? {}).every(([field, value]) => values[spec.fields.findIndex((f) => f.name === field)] === value));
  return rule!.then;
}

/** Every combination of inputs, in order, up to a limit. */
function combinations(spec: AppSpec, limit: number): string[][] {
  let out: string[][] = [[]];
  for (const f of spec.fields) out = out.flatMap((prefix) => f.values.map((v) => [...prefix, v])).slice(0, limit);
  return out;
}

/** The files the spec writes into a fresh `npx prism-code init` instance. Paths are relative to its root. */
export function generate(input: AppSpec): Record<string, string | null> {
  const spec = checkSpec(input);
  const n = spec.fields.length;
  const F = spec.fields.map((_, i) => `f${i + 1}`);
  const outcomeIndex = (o: string) => spec.outcomes.indexOf(o);
  const valueIndex = (field: string, value: string) => spec.fields.find((f) => f.name === field)!.values.indexOf(value);
  const params = F.map((f) => `${f} : Nat`).join(', ');
  const args = F.join(' ');
  const requestMaximum = Math.min(255, spec.fields.reduce((sum, f) => sum + Math.max(...f.values.map((v) => v.length)), 0) + n - 1);
  const responseMaximum = Math.max(16, ...spec.outcomes.map((o) => Buffer.byteLength(o, 'utf8')));
  const nested = (branches: string[], last: string) => branches.reduceRight((acc, b) => b.replace('ELSE', acc), last);

  const parsers = spec.fields.map((f, i) => `definition{
  name: parseF${i + 1},
  parameters: [value : Bytes],
  result: (Option Nat),
  body: ${nested(f.values.map((v, j) => `(if (prim equal value ${hex(v)} : Bool) then (ctor Option.some [Nat] ${j}) else ELSE)`), '(ctor Option.none [Nat])')}
}`);
  const decoders = spec.fields.map((_, k) => {
    const i = k + 1;
    const known = F.slice(0, k).map((f) => `${f} : Nat`);
    const last = i === n;
    const next = last
      ? `(if (e =? (Foundation.Bytes::byteLength s)) then (ctor Option.some [Request] (record Request {${F.map((f) => `${f} := ${f}`).join(', ')}})) else (ctor Option.none [Request]))`
      : `(if (e <? (Foundation.Bytes::byteLength s)) then (decodeF${i + 1} s (e + 1)${F.slice(0, i).map((f) => ` ${f}`).join('')}) else (ctor Option.none [Request]))`;
    return `definition{
  name: decodeF${i},
  parameters: [${['s : Bytes', 'start : Nat', ...known].join(', ')}],
  result: (Option Request),
  body: (let e : Nat := (fieldEnd s start (Foundation.Bytes::byteLength s)); (match (parseF${i} (sliceOf s start (prim subtract e start : Nat)))
    | Option.none => (ctor Option.none [Request])
    | Option.some f${i} => ${next})),
  axioms: [Quot.sound, propext]
}`;
  });
  const ruleDefs = spec.rules.map((r, k) => {
    const terms = Object.entries(r.when ?? {}).map(([field, value]) => `(f${spec.fields.findIndex((f) => f.name === field) + 1} =? ${valueIndex(field, value)})`);
    const body = terms.length === 0 ? 'true' : terms.reduceRight((acc, t) => (acc ? `(${t} && ${acc})` : t), '');
    return `definition{
  name: rule${k + 1},
  parameters: [${params}],
  result: Bool,
  body: ${body}
}`;
  });
  const decideBody = nested(spec.rules.slice(0, -1).map((r, k) => `(if (rule${k + 1} ${args}) then ${outcomeIndex(r.then)} else ELSE)`), String(outcomeIndex(spec.rules.at(-1)!.then)));
  const K = spec.outcomes.length - 1;
  const ruleTheorems = spec.rules.map((r, k) => {
    const earlier = spec.rules.slice(0, k).map((_, j) => `(not (rule${j + 1} ${args}))`);
    const guard = [`(rule${k + 1} ${args})`, ...earlier].reduceRight((acc, t) => (acc ? `(${t} && ${acc})` : t), '');
    return `definition{
  name: breaksRule${k + 1}Decides,
  parameters: [${params}],
  result: Bool,
  body: (${guard} && (not ((judge ${args}) =? ${outcomeIndex(r.then)})))
}

theorem{
  name: rule${k + 1}Decides,
  parameters: [${params}],
  statement: ((breaksRule${k + 1}Decides ${args}) = false),
  proof: linear_arithmetic{definitions: [${[`breaksRule${k + 1}Decides`, 'judge', ...spec.rules.map((_, j) => `rule${j + 1}`)].sort().join(', ')}]},
  axioms: [Quot.sound, propext]
}`;
  });
  const encode = nested(spec.outcomes.map((o, i) => `(if (code =? ${i}) then ${hex(o)} else ELSE)`), hex('invalid'));

  const valid = combinations(spec, 128).map((values) => ({ request: values.join(' '), response: decide(spec, values) }));
  const firstValues = spec.fields.map((f) => f.values[0]);
  const invalid = ['', 'zz-unknown', firstValues.slice(0, Math.max(0, n - 1)).join(' '), [...firstValues, firstValues[0]].join(' '), firstValues.join('  ')]
    .filter((r, i, all) => all.indexOf(r) === i && !valid.some((v) => v.request === r))
    .map((request) => ({ request, response: 'invalid' }));
  const vectors = [...valid, ...invalid];
  const vectorList = vectors.reduceRight((acc, v) => `(cons (record Foundation.View.Text.V1.Model::AcceptanceVector {request := ${hex(v.request)}, response := ${hex(v.response)}}) ${acc})`, '(nil Foundation.View.Text.V1.Model::AcceptanceVector)');
  const title = plain(spec.title, 60);
  const purpose = plain(spec.purpose, 200);
  const inputLabel = plain(spec.fields.map((f) => `${f.name} (${f.values.join('/')})`).join(' '), 120);

  const contract = `\\begin{lexlean}{Contract}
\\useglossary{lexlean.std.bool@1.2.0}
\\useglossary{lexlean.std.nat@1.2.0}
\\useglossary{prism.arch@1.0.0}
\\importmodule{Foundation.Bytes}
\\importmodule{Foundation.View.Text.V1.Model}
\\title{Text application model}
\\begin{semanticmodule}
structure{
  name: Request,
  type_parameters: [],
  parameters: [],
  fields: [
${F.map((f) => `    {name: ${f}, type: Nat}`).join(',\n')}
  ]
}

definition{
  name: byteAt,
  parameters: [s : Bytes, i : Nat],
  result: (Option Nat),
  body: (match (prim index s i : (Option UInt8))
    | Option.none => (ctor Option.none [Nat])
    | Option.some b => (ctor Option.some [Nat] (prim to_nat b : Nat))),
  axioms: [Quot.sound, propext]
}

definition{
  name: sliceOf,
  parameters: [s : Bytes, start : Nat, count : Nat],
  result: Bytes,
  body: (match (prim slice s start count : (Option Bytes))
    | Option.none => 0x
    | Option.some part => part)
}

definition{
  name: fieldEnd,
  parameters: [s : Bytes, i : Nat, fuel : Nat],
  result: Nat,
  body: (match fuel
    | Nat.zero => i
    | Nat.succ rest => (match (byteAt s i)
      | Option.none => i
      | Option.some d => (if (d =? 32) then i else (fieldEnd s (i + 1) rest)))),
  axioms: [Quot.sound, propext],
  recursive_argument: fuel
}

${parsers.join('\n\n')}

${[...decoders].reverse().join('\n\n')}

${ruleDefs.join('\n\n')}

definition{
  name: judge,
  parameters: [${params}],
  result: Nat,
  body: ${decideBody}
}

definition{
  name: breaksAnswersDeclared,
  parameters: [${params}],
  result: Bool,
  body: (not ((judge ${args}) <=? ${K}))
}

theorem{
  name: answersDeclared,
  parameters: [${params}],
  statement: ((breaksAnswersDeclared ${args}) = false),
  proof: linear_arithmetic{definitions: [${['breaksAnswersDeclared', 'judge', ...spec.rules.map((_, j) => `rule${j + 1}`)].sort().join(', ')}]},
  axioms: [Quot.sound, propext]
}

${ruleTheorems.join('\n\n')}

definition{
  name: encodeAnswer,
  parameters: [code : Nat],
  result: Bytes,
  body: ${encode}
}

definition{
  name: dispatch,
  parameters: [value : Bytes],
  result: Bytes,
  body: (if (${requestMaximum} <? (Foundation.Bytes::byteLength value)) then ${hex('invalid')} else (match (decodeF1 value 0)
    | Option.none => ${hex('invalid')}
    | Option.some request => (encodeAnswer (judge ${F.map((f) => `(project request ${f})`).join(' ')})))),
  axioms: [Quot.sound, propext]
}

definition{
  name: application,
  parameters: [],
  result: Foundation.View.Text.V1.Model::TextApplication,
  body: (record Foundation.View.Text.V1.Model::TextApplication {profile := "prismpm/text-application/1", name := "${title}", cargoName := "${spec.name}", cargoVersion := "0.1.0", cargoDescription := "${purpose}", cargoRepository := "https://github.com/UOR-Foundation/q", cargoHomepage := "https://github.com/UOR-Foundation/q", libraryRoots := (cons "PrismTemplateContract.Contract.dispatch" (nil String)), acceptanceVectors := ${vectorList}, entryRoot := "PrismTemplateContract.Contract.dispatch", coreContract := "hologram:guest/core-wasm@1", requestMaximum := (${requestMaximum} : UInt32), responseMaximum := (${responseMaximum} : UInt32), guestAllocationMaximum := (${Math.max(512, 2 * (requestMaximum + responseMaximum))} : UInt32), capabilitiesEmpty := true, fatArchive := true, primaryLayer := (0 : UInt8), viewLayer := (1 : UInt8), view := (record Foundation.View.Text.V1.Model::TextView {title := "${title}", heading := "${title}", inputLabel := "${inputLabel}", submitLabel := "Decide", outputLabel := "Answer", inputError := "Invalid request", responseError := "Invalid response"})})
}
\\end{semanticmodule}
\\end{lexlean}
`;

  const header = `# model/ids.toml: the conformance ID register, generated by Q (UOR-Foundation/q, host/src/appgen.ts) from one spec.\n`;
  const ids = `${header}spec = "template/2"

[[id]]
id = "APP-01"
level = "build"
suite = "app"
statement = "Every request the app accepts is answered with one of its declared outcomes"
theorems = ["Contract.answersDeclared"]

[[id]]
id = "APP-02"
level = "build"
suite = "app"
statement = "Each rule decides its own outcome whenever it is the first rule to match"
theorems = [${spec.rules.map((_, k) => `"Contract.rule${k + 1}Decides"`).join(', ')}]
`;
  const feature = `Feature: app

  ${purpose}

  @APP-01 @build
  Scenario: Every request the app accepts is answered with one of its declared outcomes
    Given the model in app/src/Contract.lex.tex
    When prism-code check has Lean's kernel prove Contract.answersDeclared
    Then the answer to every request is one of the ${spec.outcomes.length} declared outcomes

  @APP-02 @build
  Scenario: Each rule decides its own outcome whenever it is the first rule to match
    Given the model in app/src/Contract.lex.tex
    When prism-code check has Lean's kernel prove each rule's Decides theorem
    Then prism-code build replays every combination of inputs, each answered as the first matching rule says
`;
  return {
    'app/src/Contract.lex.tex': contract,
    'model/ids.toml': ids,
    'features/suites/app.feature': feature,
    'features/suites/contract.feature': null,
  };
}
