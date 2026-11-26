// MCP tools, as LangBot offers them to its runner: every tool of every configured server is
// offered to the language model, and every call it asks for is put to the kernel first
// (decision 15). The host only reports facts: whether the server is on the allowlist,
// and whether the tool writes. A tool writes unless its server marks it read-only.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

/** One server, from MCP_SERVERS: a Streamable HTTP url or a command to run, and whether it is allowlisted. */
export interface ServerConfig { name: string; url?: string; command?: string; args?: string[]; allow?: boolean }

export interface Tool {
  server: string;
  name: string;
  /** Unique across servers, as the language model sees it. */
  qualified: string;
  description: string;
  inputSchema: Record<string, unknown>;
  writes: boolean;
  allowlisted: boolean;
}

const qualify = (server: string, tool: string) => `${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);

export class Tools {
  #clients = new Map<string, Client>();
  #tools = new Map<string, Tool>();
  #closed = false;

  /** Discover a complete, unambiguous server catalog before publishing it. */
  static async connect(servers: ServerConfig[], transport: (server: ServerConfig) => Transport = defaultTransport): Promise<{ tools: Tools; failed: string[] }> {
    const tools = new Tools();
    const failed: string[] = [];
    const names = new Map<string, number>();
    for (const server of servers) names.set(server.name, (names.get(server.name) ?? 0) + 1);
    for (const server of servers) {
      if (names.get(server.name) !== 1) {
        failed.push('MCP registration refused: duplicate server name');
        continue;
      }
      const client = new Client({ name: 'uor-foundation-q', version: '0.1.0' });
      try {
        await client.connect(transport(server));
        await tools.add(server, client);
      } catch {
        await client.close().catch(() => {});
        failed.push('MCP registration failed');
      }
    }
    return { tools, failed };
  }

  async add(server: ServerConfig, client: Client) {
    const name = server.name;
    const allowlisted = server.allow === true;
    if (this.#closed || typeof name !== 'string' || !name.trim() || this.#clients.has(name)) throw Error('MCP registration refused');
    const { tools } = await client.listTools();
    const pending = new Map<string, Tool>();
    for (const tool of tools) {
      const qualified = qualify(name, tool.name);
      if (pending.has(qualified)) throw Error('MCP registration refused');
      pending.set(qualified, Object.freeze({
        server: name, name: tool.name, qualified,
        description: tool.description ?? tool.name, inputSchema: tool.inputSchema as Record<string, unknown>,
        writes: tool.annotations?.readOnlyHint !== true, allowlisted,
      }));
    }
    // Discovery awaited I/O. Recheck against the current registry before committing
    // either the client or any entry; no partial catalog can become visible.
    if (this.#closed || this.#clients.has(name) || [...pending.keys()].some(key => this.#tools.has(key))) throw Error('MCP registration refused');
    this.#clients.set(name, client);
    for (const [key, tool] of pending) this.#tools.set(key, tool);
  }

  list(): readonly Tool[] {
    return [...this.#tools.values()];
  }

  find(qualified: string): Tool | undefined {
    return this.#tools.get(qualified);
  }

  /** Run the registered entry the kernel allowed, never a reconstructed descriptor. */
  async call(tool: Tool, args: Record<string, unknown>): Promise<string> {
    const client = this.#clients.get(tool.server);
    if (this.#closed || !client || this.#tools.get(tool.qualified) !== tool) throw Error('MCP call refused: unregistered tool');
    const result = await client.callTool({ name: tool.name, arguments: args });
    const content = (result.content ?? []) as { type: string; text?: string }[];
    const text = content.flatMap((part) => (part.type === 'text' && part.text ? [part.text] : [])).join('\n');
    return result.isError ? `The tool reported an error: ${text}` : text;
  }

  async close() {
    this.#closed = true;
    const clients = [...this.#clients.values()];
    this.#clients.clear();
    this.#tools.clear();
    await Promise.all(clients.map(client => client.close()));
  }
}

function defaultTransport(server: ServerConfig): Transport {
  if (server.url) return new StreamableHTTPClientTransport(new URL(server.url));
  if (server.command) return new StdioClientTransport({ command: server.command, args: server.args ?? [] });
  throw new Error('a server needs a url or a command');
}
