import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Per-project session persistence.
 *
 * Maps a projectKey (the repo path) -> the last Claude Code SDK session id, so a
 * reconnecting director can `resume` the same session and pick up the code-state
 * context (the SDK's half of memory) instead of starting cold. Pairs with Takt's
 * own cross-channel memory of the creative intent.
 *
 * Small, infrequently-written file; sync fs is fine.
 */
const STORE_PATH = join(homedir(), '.takt-director', 'sessions.json');

type Store = Record<string, string>;

function read(): Store {
  try {
    if (!existsSync(STORE_PATH)) return {};
    return JSON.parse(readFileSync(STORE_PATH, 'utf8')) as Store;
  } catch {
    return {};
  }
}

function write(store: Store): void {
  try {
    mkdirSync(dirname(STORE_PATH), { recursive: true });
    writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
  } catch {
    /* best-effort persistence */
  }
}

export function loadSessionId(projectKey: string): string | undefined {
  return read()[projectKey];
}

export function saveSessionId(projectKey: string, sessionId: string): void {
  const store = read();
  if (store[projectKey] === sessionId) return;
  store[projectKey] = sessionId;
  write(store);
}
