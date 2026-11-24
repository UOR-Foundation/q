// The language model and the embedding model, each behind one interface.
import Anthropic from '@anthropic-ai/sdk';

export interface ToolSpec { name: string; description: string; parameters: Record<string, unknown> }
export interface ToolCall { name: string; arguments: Record<string, unknown> }
/** Answers one tool call: with its result, or with why it was refused. */
export type RunTool = (call: ToolCall) => Promise<string>;

export interface Llm {
  /** The model, by the name its provider gives it: part of every answer key. */
  readonly model: string;
  complete(system: string, user: string): Promise<string>;
  /** The same, with tools the model may ask for; each call goes through `run`. At most `rounds` rounds of calls. */
  completeWithTools?(system: string, user: string, tools: ToolSpec[], run: RunTool, rounds?: number): Promise<string>;
}

const parseArguments = (text: string): Record<string, unknown> => {
  try {
    const value = JSON.parse(text || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
};
export interface Embedder {
  readonly model: string;
  /** A question is embedded as a query, everything stored as a document: some models are trained to tell them apart. */
  embed(texts: string[], kind?: 'query' | 'document'): Promise<number[][]>;
}

export class AnthropicLlm implements Llm {
  #client: Anthropic;
  model: string;
  maxTokens: number;
  #gate: Gate;
  constructor(apiKey: string, model: string, maxTokens = 1024, concurrency = 2) {
    // The SDK retries a busy answer (429, 529) itself; the gate keeps Q under the plan's cap.
    this.#client = new Anthropic({ apiKey, maxRetries: 4 });
    this.model = model;
    this.maxTokens = maxTokens;
    this.#gate = new Gate(concurrency);
  }
  async complete(system: string, user: string) {
    const message = await this.#gate.run(() => this.#client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }));
    return message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
  }
  async completeWithTools(system: string, user: string, tools: ToolSpec[], run: RunTool, rounds = 3) {
    type Block = Anthropic.Messages.ContentBlockParam;
    const messages: Anthropic.Messages.MessageParam[] = [{ role: 'user', content: user }];
    const specs = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Messages.Tool.InputSchema }));
    for (let round = 0; ; round++) {
      const message = await this.#gate.run(() => this.#client.messages.create({ model: this.model, max_tokens: this.maxTokens, system, messages, ...(round < rounds ? { tools: specs } : {}) }));
      const calls = message.content.filter((block) => block.type === 'tool_use');
      if (!calls.length) return message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
      messages.push({ role: 'assistant', content: message.content as Block[] });
      const results: Block[] = [];
      for (const call of calls) results.push({ type: 'tool_result', tool_use_id: call.id, content: await run({ name: call.name, arguments: (call.input ?? {}) as Record<string, unknown> }) });
      messages.push({ role: 'user', content: results });
    }
  }
}

/** If a model still emits its reasoning, keep only what follows the last closing think tag. */
export const withoutReasoning = (text: string) => {
  const end = text.lastIndexOf('</think>');
  return (end >= 0 ? text.slice(end + '</think>'.length) : text).trim();
};

/**
 * At most `limit` calls at once; the rest wait their turn in order. A provider's plan caps concurrent
 * requests, and a request over the cap is refused, not queued, so the queue has to be here.
 */
export class Gate {
  #running = 0;
  #waiting: (() => void)[] = [];
  readonly limit: number;
  constructor(limit: number) {
    this.limit = Math.max(1, limit);
  }
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.#running >= this.limit) await new Promise<void>((resolve) => this.#waiting.push(resolve));
    this.#running++;
    try {
      return await work();
    } finally {
      this.#running--;
      this.#waiting.shift()?.();
    }
  }
}

/**
 * A request, retried while the provider says it is busy (429, 503): after its Retry-After, or after
 * 1, 2 and 4 seconds and then every 8, about 50 seconds in all: a plan's concurrency cap frees slowly. Any other failure, or busy past that, is thrown.
 */
export async function retrying(request: () => Promise<Response>, waits = [1000, 2000, 4000, 8000, 8000, 8000, 8000, 8000], sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await request();
    if (response.ok) return response;
    if ((response.status === 429 || response.status === 503) && attempt < waits.length) {
      const after = Number(response.headers.get('retry-after'));
      await response.body?.cancel();
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 30_000) : waits[attempt]);
      continue;
    }
    throw new Error(`chat completions: ${response.status} ${await response.text()}`);
  }
}

/**
 * How a provider reaches the network: fetch, unless a chaos experiment puts a faulty network in its place
 * (chaos.ts), so a fault takes the path a real one would, through the gate and the retries.
 */
export type Transport = typeof fetch;

/** Any server with the OpenAI chat completions route: OpenAI, xAI, or Ollama for a local model. */
export class OpenAiCompatibleLlm implements Llm {
  #baseUrl: string;
  #apiKey: string;
  model: string;
  thinking: boolean;
  maxTokens: number;
  #gate: Gate;
  #transport: Transport;
  constructor(baseUrl: string, apiKey: string, model: string, thinking = true, maxTokens = 1024, concurrency = 2, transport: Transport = fetch) {
    this.#baseUrl = baseUrl;
    this.#apiKey = apiKey;
    this.model = model;
    this.thinking = thinking;
    this.maxTokens = maxTokens;
    this.#gate = new Gate(concurrency);
    this.#transport = transport;
  }
  /** One chat completion, inside the gate, retried when the provider is busy. */
  #post(body: Record<string, unknown>) {
    return this.#gate.run(() => retrying(() => this.#transport(`${this.#baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#apiKey}` },
      body: JSON.stringify(body),
    })));
  }
  async complete(system: string, user: string) {
    const response = await this.#post({
      model: this.model,
      max_tokens: this.maxTokens,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      // Reasoning models (Qwen3, GLM, DeepSeek) otherwise write their reasoning into the answer.
      ...(this.thinking ? {} : { chat_template_kwargs: { enable_thinking: false } }),
    });
    const { choices } = (await response.json()) as { choices: { message: { content: string } }[] };
    return withoutReasoning(choices[0]?.message.content ?? '');
  }
  async completeWithTools(system: string, user: string, tools: ToolSpec[], run: RunTool, rounds = 3) {
    type Call = { id: string; type: 'function'; function: { name: string; arguments: string } };
    type Message = { role: string; content: string | null; tool_calls?: Call[]; tool_call_id?: string };
    const messages: Message[] = [{ role: 'system', content: system }, { role: 'user', content: user }];
    const specs = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    for (let round = 0; ; round++) {
      const response = await this.#post({
        model: this.model, max_tokens: this.maxTokens, messages,
        ...(round < rounds ? { tools: specs } : {}),
        ...(this.thinking ? {} : { chat_template_kwargs: { enable_thinking: false } }),
      });
      const { choices } = (await response.json()) as { choices: { message: Message }[] };
      const reply = choices[0]?.message;
      if (!reply?.tool_calls?.length) return withoutReasoning(reply?.content ?? '');
      messages.push({ role: 'assistant', content: reply.content ?? null, tool_calls: reply.tool_calls });
      for (const call of reply.tool_calls) {
        messages.push({ role: 'tool', tool_call_id: call.id, content: await run({ name: call.function.name, arguments: parseArguments(call.function.arguments) }) });
      }
    }
  }
}

/** Any server with the OpenAI embeddings route: a hosted provider, or Ollama for a local model. */
export class OpenAiCompatibleEmbedder implements Embedder {
  #baseUrl: string;
  #apiKey: string;
  readonly model: string;
  #prefix: { query: string; document: string };
  #transport: Transport;
  constructor(baseUrl: string, apiKey: string, model: string, prefix = { query: '', document: '' }, transport: Transport = fetch) {
    this.#baseUrl = baseUrl;
    this.#apiKey = apiKey;
    this.model = model;
    this.#prefix = prefix;
    this.#transport = transport;
  }
  async embed(texts: string[], kind: 'query' | 'document' = 'document') {
    const response = await this.#transport(`${this.#baseUrl.replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#apiKey}` },
      body: JSON.stringify({ model: this.model, input: texts.map((text) => this.#prefix[kind] + text) }),
    });
    if (!response.ok) throw new Error(`embeddings: ${response.status} ${await response.text()}`);
    const { data } = (await response.json()) as { data: { index: number; embedding: number[] }[] };
    return [...data].sort((a, b) => a.index - b.index).map((row) => row.embedding);
  }
}
