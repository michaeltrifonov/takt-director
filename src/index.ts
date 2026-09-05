import 'dotenv/config';
import { loadConfig } from './config';
import { ensureLogin } from './auth';
import { startAgentClient } from './bridge/client';

const config = loadConfig();
const auth = await ensureLogin(config); // silent if a cached session exists; else one-time browser login
startAgentClient(config, auth);
