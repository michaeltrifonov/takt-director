import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { TaktClient } from './taktClient';

/**
 * The consult / reverse channel.
 *
 * A standalone stdio MCP server exposing `ask_takt`, loaded into the Claude Code
 * session by the adapter. This is the natural direction for MCP here: Claude
 * initiates the call (host pulls a capability). Run on its own, it also drops
 * the director into any MCP host (Claude / Codex / Cursor).
 */
const director = new TaktClient(
  process.env.CONSULT_API_URL ?? 'http://localhost:3001',
  process.env.CONSULT_API_KEY,
  process.env.CONSULT_PATH,
);

const server = new McpServer({ name: 'takt', version: '0.0.1' });

// NOTE: the high-level tool() signature is version-sensitive — verify against the
// installed @modelcontextprotocol/sdk (recent versions may prefer registerTool()).
server.tool(
  'ask_takt',
  'Ask the director for an opinionated judgment call while you work. Use when multiple options ' +
    'are viable and you want the one that fits the brand/taste, not a neutral list.',
  {
    question: z.string().describe('the decision or question'),
    options: z.array(z.string()).optional().describe('candidate options, if any'),
    context: z.string().optional().describe('relevant context for the call'),
  },
  async ({ question, options, context }) => {
    try {
      const answer = await director.ask(question, { options, context });
      return { content: [{ type: 'text' as const, text: answer || '(the director had no answer)' }] };
    } catch (e) {
      return {
        content: [
          { type: 'text' as const, text: `ask_takt failed: ${e instanceof Error ? e.message : String(e)}` },
        ],
        isError: true,
      };
    }
  },
);

await server.connect(new StdioServerTransport());
