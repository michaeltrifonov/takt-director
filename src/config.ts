import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// takt-director package root (works under tsx `src/` and compiled `dist/`).
const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_BASH_PATTERNS = [
  'git push',
  'git commit',
  'rm -rf',
  'deploy',
  'npm publish',
  'supabase db push',
  'gh pr',
];

// Public Supabase project creds — the SAME anon/publishable key shipped in the
// Takt app bundle. The publishable key is designed to be public, so embedding it
// here (overridable by env) keeps the install one-step: the user only sets REPO_PATH.
const DEFAULT_SUPABASE_URL = 'https://kfizkdnszetbdtfmiwsy.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'sb_publishable_l7LH9QxS1YEMC2cCLvfCJQ_QxtdayYb';

export interface Config {
  anthropicApiKey: string;
  /** the local repo Claude Code works in */
  repoPath: string;
  /** the Takt server the daemon dials (socket.io origin); /agent namespace is appended */
  taktServerUrl: string;
  // ── Supabase login (the daemon authenticates AS a Takt user) ──
  supabaseUrl: string;
  supabaseAnonKey: string;
  oauthProvider: string;
  /** fixed localhost port for the OAuth callback (must be whitelisted in Supabase redirect URLs) */
  oauthCallbackPort: number;
  // ── review gate policy (the Session still classifies; server auto-denies) ──
  reviewTools: string[];
  reviewBashPatterns: string[];
  // ── ask_takt consult shim (Claude -> Takt) ──
  taktMcpCommand: string;
  taktMcpArgs: string[];
  taktApiUrl: string;
  taktConsultPath: string;
  taktApiKey?: string;
  // ── browser automation (Playwright MCP — visual QA) ──
  /** load the Playwright MCP server into the agent (browser_navigate, browser_take_screenshot, …) */
  playwrightEnabled: boolean;
  playwrightCommand: string;
  playwrightArgs: string[];
  // ── thrash breaker (per-task circuit breaker; 0 disables a limit) ──
  thrashMaxRepeats: number;    // consecutive identical tool calls before kill
  thrashMaxToolCalls: number;  // total tool calls per task before kill
  thrashMaxTokens: number;     // cumulative tokens per task before kill
}

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function list(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(): Config {
  const env = process.env;

  const anthropicApiKey = env.ANTHROPIC_API_KEY ?? '';
  if (!anthropicApiKey && !env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.warn(
      '[takt-director] No ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN set — the spawned agent will use ' +
        'your logged-in Claude Code subscription (make sure `claude` is logged in on this machine). If ' +
        'sessions fail to authenticate, run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN, or set ' +
        'ANTHROPIC_API_KEY (note: setting ANTHROPIC_API_KEY bills the API/pay-as-you-go, not your subscription).',
    );
  }

  const taktServerUrl = (env.TAKT_SERVER_URL ?? 'https://api.takt.chat').replace(/\/$/, '');
  const bashPatterns = list(env.REVIEW_BASH_PATTERNS);
  const mcpArgs = list(env.TAKT_MCP_ARGS);
  const playwrightArgs = list(env.PLAYWRIGHT_MCP_ARGS);

  return {
    anthropicApiKey,
    repoPath: env.REPO_PATH || process.cwd(),
    taktServerUrl,
    supabaseUrl: env.SUPABASE_URL || DEFAULT_SUPABASE_URL,
    supabaseAnonKey: env.SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY,
    oauthProvider: env.OAUTH_PROVIDER || 'google',
    oauthCallbackPort: Number(env.OAUTH_CALLBACK_PORT ?? 4318),
    reviewTools: list(env.REVIEW_TOOLS),
    reviewBashPatterns: bashPatterns.length ? bashPatterns : DEFAULT_BASH_PATTERNS,
    // Absolute command/args: the SDK spawns MCP servers with the TARGET REPO as cwd,
    // not takt-director, so relative paths would break. Default to takt-director's
    // own tsx + the shim source. For a compiled deploy, set TAKT_MCP_COMMAND=node
    // and TAKT_MCP_ARGS=<abs path to dist/consult/taktMcpServer.js>.
    taktMcpCommand: env.TAKT_MCP_COMMAND ?? resolve(pkgRoot, 'node_modules/.bin/tsx'),
    taktMcpArgs: mcpArgs.length ? mcpArgs : [resolve(pkgRoot, 'src/consult/taktMcpServer.ts')],
    // Consult endpoint (ask_takt). Defaults to the same Takt server; X-API-Key auth.
    taktApiUrl: env.TAKT_API_URL || taktServerUrl,
    taktConsultPath: env.TAKT_CONSULT_PATH ?? '/api/consult/ask',
    taktApiKey: env.TAKT_API_KEY || undefined,
    // Browser automation: on by default (the QA feature's whole point). Set
    // PLAYWRIGHT_MCP_ENABLED=false to skip loading it. Runs headless+isolated by
    // default; `npx @playwright/mcp` fetches the server on first use. Override the
    // command/args for a pinned/global install.
    playwrightEnabled: env.PLAYWRIGHT_MCP_ENABLED !== 'false',
    playwrightCommand: env.PLAYWRIGHT_MCP_COMMAND ?? 'npx',
    playwrightArgs: playwrightArgs.length
      ? playwrightArgs
      : ['-y', '@playwright/mcp@latest', '--headless', '--isolated'],
    // Thrash breaker: kill a worker stuck repeating itself. Repeat-run guard on by
    // default (6 identical calls in a row); total-call and token caps off by default
    // (they false-positive on legit big tasks) — opt in via env for tight loops.
    thrashMaxRepeats: num(env.THRASH_MAX_REPEATS, 6),
    thrashMaxToolCalls: num(env.THRASH_MAX_TOOL_CALLS, 0),
    thrashMaxTokens: num(env.THRASH_MAX_TOKENS, 0),
  };
}
