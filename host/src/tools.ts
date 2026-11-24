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
  #tools: Tool[] = [];

  /** Connect to every server and list its tools. A server that cannot be reached is left out and reported. */
  static async connect(servers: ServerConfig[], transport: (server: ServerConfig) => Transport = defaultTransport): Promise<{ tools: Tools; failed: string[] }> {
    const tools = new Tools();
    const failed: string[] = [];
    for (const server of servers) {
      try {
        const client = new Client({ name: 'uor-foundation-q', version: '0.1.0' });
        await client.connect(transport(server));
        await tools.add(server, client);
      } catch (error) {
        failed.push(`${server.name}: ${String(error)}`);
      }
    }
    return { tools, failed };
  }

  async add(server: ServerConfig, client: Client) {
    this.#clients.set(server.name, client);
    const { tools } = await client.listTools();
    for (const tool of tools) {
      this.#tools.push({
        server: server.name, name: tool.name, qualified: qualify(server.name, tool.name),
        description: tool.description ?? tool.name, inputSchema: tool.inputSchema as Record<string, unknown>,
        writes: tool.annotations?.readOnlyHint !== true, allowlisted: server.allow === true,
      });
    }
  }

  list(): readonly Tool[] {
    return this.#tools;
  }

  find(qualified: string): Tool | undefined {
    return this.#tools.find((tool) => tool.qualified === qualified);
  }

  /** Run one call the kernel allowed, and return its text content. */
  async call(tool: Tool, args: Record<string, unknown>): Promise<string> {
    const result = await this.#clients.get(tool.server)!.callTool({ name: tool.name, arguments: args });
    const content = (result.content ?? []) as { type: string; text?: string }[];
    const text = content.flatMap((part) => (part.type === 'text' && part.text ? [part.text] : [])).join('\n');
    return result.isError ? `The tool reported an error: ${text}` : text;
  }

  async close() {
    for (const client of this.#clients.values()) await client.close();
  }
}

function defaultTransport(server: ServerConfig): Transport {
  if (server.url) return new StreamableHTTPClientTransport(new URL(server.url));
  if (server.command) return new StdioClientTransport({ command: server.command, args: server.args ?? [] });
  throw new Error('a server needs a url or a command');
}
