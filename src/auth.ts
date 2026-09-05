import http from 'node:http';
import { exec } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import type { Config } from './config';

/**
 * Supabase login for the daemon.
 *
 * The daemon authenticates AS a Takt user, exactly like the app client: it holds
 * a Supabase session and presents the access token when it dials the server's
 * `/agent` namespace (verified there with the same `verifyToken` path). First run
 * does a one-time PKCE browser login (Google/Apple); the refresh token is cached
 * to `~/.takt-director/supabase-session.json` so subsequent runs are silent.
 *
 * Loopback + PKCE is the standard CLI auth pattern (RFC 8252): the redirect lands
 * on the user's own machine and the code is useless without the locally-held
 * verifier, so it's safe even though the redirect URL is a global allowlist entry.
 */

const SESSION_PATH = join(homedir(), '.takt-director', 'supabase-session.json');

export interface AuthHandle {
  /** A valid access token, refreshing first if it's near expiry. */
  getAccessToken(): Promise<string>;
  email?: string;
}

// In-memory storage so the PKCE code_verifier set by signInWithOAuth survives
// until exchangeCodeForSession reads it (same process run; no disk needed).
function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => m.get(k) ?? null,
    setItem: (k: string, v: string): void => void m.set(k, v),
    removeItem: (k: string): void => void m.delete(k),
  };
}

function loadSaved(): { refresh_token: string } | null {
  try {
    if (!existsSync(SESSION_PATH)) return null;
    const raw = JSON.parse(readFileSync(SESSION_PATH, 'utf8')) as { refresh_token?: string };
    return raw.refresh_token ? { refresh_token: raw.refresh_token } : null;
  } catch {
    return null;
  }
}

function saveSession(session: Session): void {
  try {
    mkdirSync(dirname(SESSION_PATH), { recursive: true });
    writeFileSync(
      SESSION_PATH,
      JSON.stringify({ refresh_token: session.refresh_token, email: session.user.email }, null, 2),
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

export async function ensureLogin(config: Config): Promise<AuthHandle> {
  const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: {
      flowType: 'pkce',
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storage: memoryStorage(),
    },
  });

  let session: Session | null = null;

  // 1) Try a cached refresh token (silent).
  const saved = loadSaved();
  if (saved?.refresh_token) {
    const { data, error } = await supabase.auth.refreshSession({ refresh_token: saved.refresh_token });
    if (!error && data.session) {
      session = data.session;
      saveSession(session);
    }
  }

  // 2) Otherwise, one-time browser login.
  if (!session) {
    session = await browserLogin(supabase, config);
    saveSession(session);
  }

  console.log(`[takt-director] logged in as ${session.user.email ?? session.user.id}`);
  let current: Session = session;

  return {
    email: current.user.email ?? undefined,
    async getAccessToken(): Promise<string> {
      const expiresAtMs = (current.expires_at ?? 0) * 1000;
      // Refresh if expired or within 60s of expiry.
      if (Date.now() > expiresAtMs - 60_000) {
        const rt = current.refresh_token ?? loadSaved()?.refresh_token;
        if (rt) {
          const { data, error } = await supabase.auth.refreshSession({ refresh_token: rt });
          if (!error && data.session) {
            current = data.session;
            saveSession(current);
          } else {
            // Transient errors self-heal (socket.io re-invokes this on reconnect).
            // A revoked refresh token won't — surface it so the user re-runs login.
            console.warn(
              `[takt-director] token refresh failed: ${error?.message ?? 'unknown'}. ` +
                'If this persists, delete ~/.takt-director/supabase-session.json and restart to sign in again.',
            );
          }
        }
      }
      return current.access_token;
    },
  };
}

async function browserLogin(supabase: SupabaseClient, config: Config): Promise<Session> {
  const redirectTo = `http://localhost:${config.oauthCallbackPort}/callback`;
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: config.oauthProvider as Parameters<SupabaseClient['auth']['signInWithOAuth']>[0]['provider'],
    options: { redirectTo, skipBrowserRedirect: true },
  });
  if (error || !data?.url) {
    throw new Error(`OAuth init failed: ${error?.message ?? 'no authorize URL returned'}`);
  }

  return new Promise<Session>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      void (async () => {
        try {
          const url = new URL(req.url ?? '', redirectTo);
          if (!url.pathname.startsWith('/callback')) {
            res.writeHead(404);
            res.end();
            return;
          }
          const code = url.searchParams.get('code');
          if (!code) {
            res.writeHead(400);
            res.end('missing authorization code');
            return;
          }
          const { data: exchanged, error: exErr } = await supabase.auth.exchangeCodeForSession(code);
          if (exErr || !exchanged.session) {
            res.writeHead(500);
            res.end('sign-in failed — check the daemon logs');
            server.close();
            reject(exErr ?? new Error('no session returned from code exchange'));
            return;
          }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(
            '<html><body style="font-family:system-ui;padding:3rem;text-align:center">' +
              '<h2>✓ Signed in to Takt</h2><p>You can close this tab and return to the terminal.</p></body></html>',
          );
          server.close();
          resolve(exchanged.session);
        } catch (e) {
          res.writeHead(500);
          res.end('error');
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
          `   if it doesn't open, visit:\n   ${data.url}`,
      );
      openBrowser(data.url);
    });
  });
}
