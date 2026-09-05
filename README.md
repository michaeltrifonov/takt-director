# takt-director

A local daemon that lets a **director** — a remote orchestrating AI — drive the **Claude Code**
agent on *your* machine. The daemon dials the director's server and registers as you. Then, when the
director decides a task needs code work, it becomes the operator at the terminal — prompting Claude
Code, reading the output, and going back and forth until it's done — then reports back in chat. The
director directs; Claude Code stays the coder. Edits **stage locally** — you review the diff and
push when satisfied.

## Install (one step)

```bash
git clone https://github.com/michaeltrifonov/takt-director.git && cd takt-director
npm install
cp .env.example .env          # set REPO_PATH (the repo to drive); everything else has defaults
npm run dev                   # signs in (token or one-time browser login) → "connected"
```

With no `ANTHROPIC_API_KEY`, it uses your logged-in Claude Code **subscription**. Daemon auth is
either a static `DIRECTOR_TOKEN` or a one-time OAuth (PKCE) browser login against your identity
provider; the session is cached to `~/.takt-director/` so later runs are silent.

## Why this shape (reverse-dial)

The daemon makes an **outbound** connection to the director server and authenticates as you with a
bearer access token. The server keeps a registry of connected daemons keyed by user id and routes
*your* code tasks to *your* daemon. This is the opposite of a classic webhook/bridge and it's what
makes the product work:

- **Works behind any NAT/firewall** — nothing is exposed publicly on your machine; no tunnel.
- **Per-user isolation** — a task can only ever reach the daemon of the user who sent the message.
- **One-step install** — no per-user server config, no `BRIDGE_URL`.

```
      chat session ─► director server ──(routes task to YOUR daemon)──► this daemon ─► Claude Code
         ▲                  │   registry: { userId → daemonSocket }         │
         └──── narrates ◄───┴──────────── streams events back ◄─────────────┘
        daemon dialed OUT to /agent and registered as you
```

Two channels, each in the direction it works:
- **Forward (push):** server → daemon → Agent SDK. The director dispatches `agent_task`, supervises, loops.
- **Reverse (pull):** Claude → `ask_takt` MCP tool → the director. Mid-task taste/strategy consults (optional).

## Layout

```
src/
  index.ts                     entrypoint — login, then start the agent client
  config.ts                    env → Config (REPO_PATH + director-server defaults)
  auth.ts                      OAuth2/OIDC PKCE browser login (or static token) + cached refresh token
  protocol.ts                  the Sub-Contractor Protocol, prepended to every dispatched task
  bridge/client.ts             outbound socket.io client → /agent namespace; wires tasks to a Session
  adapters/claudeCodeAdapter.ts  implements the Session via @anthropic-ai/claude-agent-sdk
  session/types.ts             the Session seam + wire types
  consult/                     the ask_takt MCP shim (Claude -> director)
  util/                        async queue, thrash breaker, per-repo session-id persistence
```

## How a task runs

1. You ask the director for code work in chat.
2. The director decides an `agent_task` is warranted and dispatches an instruction to your daemon.
3. The daemon runs it through Claude Code (one resumed session per repo), streaming results back.
4. The director reads the result and **decides what's next** — another round, or done.
5. When done, the director writes the final message to you in the chat.

Gated two ways (both must hold): your daemon is connected (routed per-user via the `/agent`
registry) **and** the director's server-side kill switch is on.

## The review gate

Default `permissionMode: 'acceptEdits'` — file edits auto-stage (you review the local diff yourself).
The Session flags risky/outbound tools (`git push`/`commit`, `rm -rf`, `deploy`, `npm publish`, …);
in tool mode the server **auto-denies** them — so Claude can edit your working tree but can't commit,
push, or deploy. You review `git diff` and push when satisfied.

## Local dev

Point the daemon at a local director server and run both:

```bash
# server:   npm run dev                                (:3001)
# daemon:   DIRECTOR_URL=http://localhost:3001 npm run dev
```

Same code path as prod — only the server URL differs.

## Status

In daily use as the development loop behind [takt](https://takt.chat): the daemon logs in,
registers on `/agent`, and tasks dispatched from the director run through Claude Code and report
back in chat — this is how takt's own surfaces get built. Visual QA is wired in — the agent gets a
headless browser (Playwright MCP) and its screenshots stream back to the director as images, not
descriptions. What remains gated behind the server-side kill switch is exposing dispatch to end
users inside production chats. An interactive (non-auto-deny) review gate is future work.
