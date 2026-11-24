// Q's own MCP server, as LangBot mounts one at /mcp: a curated, agent-facing subset of the same service
// layer, so other agents can ask Q, search its knowledge and ask the community's decisions. It speaks
// stdio (`node src/main.ts mcp`), so it opens no port. Every question goes through the same pipeline on
// the `mcp` surface, where the kernel withholds every private item (decision 17): nothing from Discord
// is ever served here.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { describe, type Decider } from './community.ts';
import type { Kernel } from './kernel.ts';
import type { Incoming, Pipeline } from './pipeline.ts';

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });

const TOOLS = [
  { name: 'ask', description: "Ask Q a question about the UOR Foundation. Answered from public sources only, with citations and a claim level.", inputSchema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] }, annotations: { readOnlyHint: true } },
  { name: 'search', description: "Search Q's public knowledge: the community model, uor.foundation and the organization's repositories.", inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, annotations: { readOnlyHint: true } },
  { name: 'status', description: "Q's kernel and community pins: the BLAKE3 labels and commits it runs.", inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'community_apps', description: "The UOR community's decision apps Q can ask, with each one's inputs.", inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'community_decide', description: "Ask one UOR community decision app, by name, with its inputs in order. The answer comes from the community's signed holo.", inputSchema: { type: 'object', properties: { app: { type: 'string' }, inputs: { type: 'array', items: { type: 'string' } } }, required: ['app', 'inputs'] }, annotations: { readOnlyHint: true } },
];

export function mcpServer(pipeline: Pipeline, kernel: Kernel, community: () => Decider): Server {
  const server = new Server({ name: 'uor-q', version: '0.1.0' }, { capabilities: { tools: {} } });
  const question = (command: 'ask' | 'search', value: string): Incoming => ({
    surface: 'mcp', channelId: 'mcp', authorId: 'mcp-client', role: 'member', trigger: 'slash', command, text: value,
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    switch (request.params.name) {
      case 'ask':
      case 'search': {
        const value = String(args.question ?? args.query ?? '');
        const reply = await pipeline.handle(question(request.params.name, value));
        return text(reply?.text ?? 'No answer.');
      }
      case 'status': {
        const pin = community().pin;
        return text(JSON.stringify({ kernel: { holo: kernel.holo, model: kernel.model, commit: kernel.commit }, community: { holo: pin.holo, commit: pin.commit } }, null, 2));
      }
      case 'community_apps': {
        const apps = [...community().apps.values()].map((app) => `${app.name}: ${app.purpose}\n${app.fields.map((f) => `  ${describe(f)}`).join('\n')}`);
        return text(apps.join('\n\n'));
      }
      case 'community_decide': {
        const inputs = Array.isArray(args.inputs) ? args.inputs.map(String) : [];
        try {
          const pin = community().pin;
          const answer = await community().decide(String(args.app ?? ''), inputs);
          return text(`${answer}\n\nDecided by ${String(args.app)} in UOR-Foundation/community at ${pin.commit.slice(0, 7)}, holo ${pin.holo}.`);
        } catch (error) {
          return { ...text(String(error instanceof Error ? error.message : error)), isError: true };
        }
      }
      default:
        return { ...text(`No tool named ${request.params.name}.`), isError: true };
    }
  });
  return server;
}
