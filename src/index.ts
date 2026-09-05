import 'dotenv/config';
import { loadConfig } from './config';
import { ensureLogin } from './auth';
import { startAgentClient } from './bridge/client';

void (async () => {
  const config = loadConfig();
  const auth = await ensureLogin(config); // silent if a cached session exists; else one-time browser login
  console.log('[takt-director] Director Protocol active — side-loaded into every dispatched task (src/protocol.ts)');
  startAgentClient(config, auth);
})();
