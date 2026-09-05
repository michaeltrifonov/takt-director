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

export interface Config {
  /** the local repo Claude Code works in */
  repoPath: string;
  /** the director server the daemon dials (socket.io origin); /agent namespace is appended */
  directorUrl: string;

  // ── daemon auth (how the daemon proves who it is to the director server) ──
  /** static bearer token, provisioned out of band; when set, no browser login happens */
  directorToken?: string;
  /** OAuth2/OIDC endpoints for the one-time PKCE browser login (unused with a static token) */
  oauthAuthorizeUrl: string;
  oauthTokenUrl: string;
  oauthClientId: string;
  oauthScopes: string;
  /** fixed localhost port for the OAuth callback (http://localhost:<port>/callback must be an allowed redirect URI) */
  oauthCallbackPort: number;

  // ── review gate policy (the Session still classifies; server auto-denies) ──
  reviewTools: string[];
  reviewBashPatterns: string[];

  // ── ask_takt consult shim (Claude -> director) ──
  consultMcpCommand: string;
  consultMcpArgs: string[];
  consultApiUrl: string;
  consultPath: string;
  consultApiKey?: string;

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

  if (!env.ANTHROPIC_API_KEY && !env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.warn(
      '[takt-director] No ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN set — the spawned agent will use ' +
        'your logged-in Claude Code subscription (make sure `claude` is logged in on this machine). If ' +
        'sessions fail to authenticate, run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN, or set ' +
        'ANTHROPIC_API_KEY (note: setting ANTHROPIC_API_KEY bills the API/pay-as-you-go, not your subscription).',
    );
  }

  const directorUrl = (env.DIRECTOR_URL ?? 'http://localhost:3001').replace(/\/$/, '');
  const bashPatterns = list(env.REVIEW_BASH_PATTERNS);
  const mcpArgs = list(env.CONSULT_MCP_ARGS);
  const playwrightArgs = list(env.PLAYWRIGHT_MCP_ARGS);

  return {
    repoPath: env.REPO_PATH || process.cwd(),
    directorUrl,
    directorToken: env.DIRECTOR_TOKEN || undefined,
    oauthAuthorizeUrl: env.OAUTH_AUTHORIZE_URL ?? '',
    oauthTokenUrl: env.OAUTH_TOKEN_URL ?? '',
    oauthClientId: env.OAUTH_CLIENT_ID ?? '',
    oauthScopes: env.OAUTH_SCOPES ?? 'openid email offline_access',
    oauthCallbackPort: num(env.OAUTH_CALLBACK_PORT, 4318),
    reviewTools: list(env.REVIEW_TOOLS),
    reviewBashPatterns: bashPatterns.length ? bashPatterns : DEFAULT_BASH_PATTERNS,
    // Absolute command/args: the SDK spawns MCP servers with the TARGET REPO as cwd,
    // not takt-director, so relative paths would break. Default to takt-director's
    // own tsx + the shim source. For a compiled deploy, set CONSULT_MCP_COMMAND=node
    // and CONSULT_MCP_ARGS=<abs path to dist/consult/taktMcpServer.js>.
    consultMcpCommand: env.CONSULT_MCP_COMMAND ?? resolve(pkgRoot, 'node_modules/.bin/tsx'),
    consultMcpArgs: mcpArgs.length ? mcpArgs : [resolve(pkgRoot, 'src/consult/taktMcpServer.ts')],
    // Consult endpoint (ask_takt). Defaults to the same director server; X-API-Key auth.
    consultApiUrl: env.CONSULT_API_URL || directorUrl,
    consultPath: env.CONSULT_PATH ?? '/api/consult/ask',
    consultApiKey: env.CONSULT_API_KEY || undefined,
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
