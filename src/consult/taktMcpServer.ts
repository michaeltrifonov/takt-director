import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { TaktClient } from './taktClient';

/**
 * Takt-MCP — the consult / reverse channel.
 *
 * A standalone stdio MCP server exposing `ask_takt`, loaded into the Claude Code
 * session by the adapter. This is the *legit* use of MCP here: Claude initiates the
 * call (host pulls a capability). It is also the shippable "drop Takt into any MCP
 * host (Claude / Codex / Cursor)" artifact — the reach play — run on its own.
 */
const takt = new TaktClient(
  process.env.TAKT_API_URL ?? 'http://localhost:8080',
  process.env.TAKT_API_KEY,
  process.env.TAKT_CONSULT_PATH,
);

const server = new McpServer({ name: 'takt', version: '0.0.1' });

// NOTE: the high-level tool() signature is version-sensitive — verify against the
// installed @modelcontextprotocol/sdk (recent versions may prefer registerTool()).
server.tool(
  'ask_takt',
  'Ask Takt — the creative/strategic director — for an opinionated judgment call while you work. ' +
    'Use when multiple options are viable and you want the one that fits the brand/taste, not a neutral list.',
  {
    question: z.string().describe('the decision or question'),
    options: z.array(z.string()).optional().describe('candidate options, if any'),
    context: z.string().optional().describe('relevant context for the call'),
  },
  async ({ question, options, context }) => {
    try {
      const answer = await takt.ask(question, { options, context });
      return { content: [{ type: 'text' as const, text: answer || '(takt had no answer)' }] };
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
