import http from 'node:http';
import { exec } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Config } from './config';

/**
 * Daemon auth.
 *
 * The daemon authenticates AS a user of the director service: it presents a
 * bearer access token when it dials the server's `/agent` namespace, and the
 * server verifies it against the same identity provider its app clients use.
 * Two ways in:
 *
 *   - DIRECTOR_TOKEN — a static token provisioned out of band. Simplest; no browser.
 *   - OAuth2/OIDC PKCE — first run does a one-time browser login against the
 *     configured authorize/token endpoints; the refresh token is cached to
 *     `~/.takt-director/session.json` so subsequent runs are silent.
 *
 * Loopback + PKCE is the standard CLI auth pattern (RFC 8252): the redirect lands
 * on the user's own machine and the code is useless without the locally-held
 * verifier, so a fixed localhost redirect URI is safe to allowlist globally.
 */

const SESSION_PATH = join(homedir(), '.takt-director', 'session.json');

export interface AuthHandle {
  /** A valid access token, refreshing first if it's near expiry. */
  getAccessToken(): Promise<string>;
  email?: string;
}

interface TokenSet {
  accessToken: string;
  /** epoch ms; 0 = unknown (treated as long-lived) */
  expiresAtMs: number;
  refreshToken?: string;
  email?: string;
}

const b64url = (buf: Buffer): string => buf.toString('base64url');

function loadSaved(): { refresh_token: string } | null {
  try {
    if (!existsSync(SESSION_PATH)) return null;
    const raw = JSON.parse(readFileSync(SESSION_PATH, 'utf8')) as { refresh_token?: string };
    return raw.refresh_token ? { refresh_token: raw.refresh_token } : null;
  } catch {
    return null;
  }
}

function saveSession(t: TokenSet): void {
  if (!t.refreshToken) return;
  try {
    mkdirSync(dirname(SESSION_PATH), { recursive: true });
    writeFileSync(
      SESSION_PATH,
      JSON.stringify({ refresh_token: t.refreshToken, email: t.email }, null, 2),
      'utf8',
    );
  } catch {
    /* best-effort persistence */
  }
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
  exec(`${cmd} "${url}"`, () => {
    /* if it fails the URL is also printed to the console */
  });
}

/** Best-effort display identity from an OIDC id_token (claims are not verified — display only). */
function emailFromIdToken(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
      email?: string;
    };
    return typeof payload.email === 'string' ? payload.email : undefined;
  } catch {
    return undefined;
  }
}

async function tokenRequest(config: Config, params: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(config.oauthTokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.oauthClientId, ...params }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`token endpoint returned ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    id_token?: string;
  };
  if (!data.access_token) throw new Error('token endpoint returned no access_token');
  return {
    accessToken: data.access_token,
    expiresAtMs: data.expires_in ? Date.now() + data.expires_in * 1000 : 0,
    refreshToken: data.refresh_token,
    email: emailFromIdToken(data.id_token),
  };
}

export async function ensureLogin(config: Config): Promise<AuthHandle> {
  // Static token: nothing to negotiate, nothing to refresh.
  if (config.directorToken) {
    const token = config.directorToken;
    console.log('[takt-director] using DIRECTOR_TOKEN for auth');
    return { getAccessToken: async () => token };
  }

  if (!config.oauthAuthorizeUrl || !config.oauthTokenUrl || !config.oauthClientId) {
    throw new Error(
      'no auth configured — set DIRECTOR_TOKEN, or OAUTH_AUTHORIZE_URL + OAUTH_TOKEN_URL + OAUTH_CLIENT_ID ' +
        'for the one-time browser login (see .env.example)',
    );
  }

  let current: TokenSet | null = null;

  // 1) Try a cached refresh token (silent).
  const saved = loadSaved();
  if (saved?.refresh_token) {
    try {
      current = await tokenRequest(config, { grant_type: 'refresh_token', refresh_token: saved.refresh_token });
      // Providers that rotate refresh tokens return a new one; keep whichever is live.
      current.refreshToken ??= saved.refresh_token;
      saveSession(current);
    } catch {
      current = null; // fall through to a fresh browser login
    }
  }

  // 2) Otherwise, one-time browser login.
  if (!current) {
    current = await browserLogin(config);
    saveSession(current);
  }

  console.log(`[takt-director] logged in${current.email ? ` as ${current.email}` : ''}`);
  let live: TokenSet = current;

  return {
    email: live.email,
    async getAccessToken(): Promise<string> {
      // Refresh if expired or within 60s of expiry (unknown expiry = long-lived).
      if (live.expiresAtMs > 0 && Date.now() > live.expiresAtMs - 60_000) {
        const rt = live.refreshToken ?? loadSaved()?.refresh_token;
        if (rt) {
          try {
            const next = await tokenRequest(config, { grant_type: 'refresh_token', refresh_token: rt });
            next.refreshToken ??= rt;
            next.email ??= live.email;
            live = next;
            saveSession(live);
          } catch (e) {
            // Transient errors self-heal (socket.io re-invokes this on reconnect).
            // A revoked refresh token won't — surface it so the user re-runs login.
            console.warn(
              `[takt-director] token refresh failed: ${e instanceof Error ? e.message : String(e)}. ` +
                'If this persists, delete ~/.takt-director/session.json and restart to sign in again.',
            );
          }
        }
      }
      return live.accessToken;
    },
  };
}

async function browserLogin(config: Config): Promise<TokenSet> {
  const redirectUri = `http://localhost:${config.oauthCallbackPort}/callback`;
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(16));

  const authorize = new URL(config.oauthAuthorizeUrl);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('client_id', config.oauthClientId);
  authorize.searchParams.set('redirect_uri', redirectUri);
  authorize.searchParams.set('code_challenge', b64url(createHash('sha256').update(verifier).digest()));
  authorize.searchParams.set('code_challenge_method', 'S256');
  authorize.searchParams.set('state', state);
  if (config.oauthScopes) authorize.searchParams.set('scope', config.oauthScopes);

  return new Promise<TokenSet>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      void (async () => {
        try {
          const url = new URL(req.url ?? '', redirectUri);
          if (!url.pathname.startsWith('/callback')) {
            res.writeHead(404);
            res.end();
            return;
          }
          const code = url.searchParams.get('code');
          if (!code || url.searchParams.get('state') !== state) {
            res.writeHead(400);
            res.end('missing authorization code or state mismatch');
            return;
          }
          const tokens = await tokenRequest(config, {
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            code_verifier: verifier,
          });
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(
            '<html><body style="font-family:system-ui;padding:3rem;text-align:center">' +
              '<h2>Signed in</h2><p>You can close this tab and return to the terminal.</p></body></html>',
          );
          server.close();
          resolve(tokens);
        } catch (e) {
          res.writeHead(500);
          res.end('sign-in failed — check the daemon logs');
          server.close();
          reject(e as Error);
        }
      })();
    });

    server.on('error', reject);
    // Bind loopback only (RFC 8252) — the callback must not be reachable from the LAN.
    server.listen(config.oauthCallbackPort, '127.0.0.1', () => {
      console.log(
        `[takt-director] opening your browser to sign in…\n` +
          `   if it doesn't open, visit:\n   ${authorize.toString()}`,
      );
      openBrowser(authorize.toString());
    });
  });
}
