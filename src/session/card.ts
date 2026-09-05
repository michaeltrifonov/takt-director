import type { AgentCard } from './types';

/**
 * The Agent-Card handshake Takt fetches from `GET /agent-card` (and that a future
 * A2A exposure would publish). Describes what this director endpoint can do.
 */
export function buildAgentCard(): AgentCard {
  return {
    name: 'takt-director',
    description:
      'Local bridge that lets Takt drive an agent on this machine. ' +
      'Delegate a task, stream progress + artifacts, gate risky actions behind a human review.',
    version: '0.0.1',
    streaming: true,
    pushNotifications: false,
    skills: [
      {
        id: 'agent-task',
        name: 'Agent task',
        description:
          'Hand a natural-language task to the local agent — coding or operating wired-in tools/data. ' +
          'Edits stage locally; results and a diff/preview stream back for review.',
      },
    ],
  };
}
