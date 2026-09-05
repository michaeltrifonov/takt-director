# takt-director

A local daemon that lets **Takt** drive the **Claude Code** agent on *your* machine. You sign in
with your Takt account; the daemon dials the Takt server and registers as you. Then, in any Takt
chat, when you ask for code work, Takt becomes the operator at the terminal — prompting Claude Code,
reading the output, and going back and forth until it's done — then reports back in the chat. Takt
is the director; Claude Code stays the coder. Edits **stage locally** — you review the diff and push
when satisfied.

## Install (one step)

```bash
git clone <takt-director repo> && cd takt-director
npm install
cp .env.example .env          # set REPO_PATH (the repo to drive); everything else has defaults
npm run dev                   # opens a browser to sign in with your Takt account → "connected"
```

With no `ANTHROPIC_API_KEY`, it uses your logged-in Claude Code **subscription**. First run does a
one-time browser login (Google/Apple); the session is cached to `~/.takt-director/` so later runs are
silent.

## Why this shape (reverse-dial)

The daemon makes an **outbound** connection to the Takt server and authenticates as you with a
Supabase access token (the same token the app client uses). The server keeps a registry of connected
daemons keyed by user id and routes *your* code tasks to *your* daemon. This is the opposite of a
classic webhook/bridge and it's what makes the product work:

- **Works behind any NAT/firewall** — nothing is exposed publicly on your machine; no tunnel.
- **Per-user isolation** — a task can only ever reach the daemon of the user who sent the message.
- **One-step install** — no per-user server config, no `BRIDGE_URL`.

```
  Takt web session ─► Takt server ──(routes task to YOUR daemon)──► this daemon ─► Claude Code
         ▲                  │   registry: { userId → daemonSocket }        │
         └──── narrates ◄───┴──────────── streams events back ◄────────────┘
   daemon dialed OUT to /agent and registered as you (Supabase login)
```

Two channels, each in the direction it works:
- **Forward (push):** server → daemon → Agent SDK. Takt dispatches `agent_task`, supervises, loops.
- **Reverse (pull):** Claude → `ask_takt` MCP tool → Takt. Mid-task taste/strategy consults (optional).

## Layout

```
src/
  index.ts                     entrypoint — login, then start the agent client
  config.ts                    env → Config (REPO_PATH + Takt/Supabase defaults)
  auth.ts                      Supabase PKCE browser login + cached refresh token
  bridge/client.ts             outbound socket.io client → /agent namespace; wires tasks to a Session
  adapters/claudeCodeAdapter.ts  implements the Session via @anthropic-ai/claude-agent-sdk
  session/types.ts             the Session seam + wire types
  consult/                     the ask_takt MCP shim (Claude -> Takt)
  util/                        async queue + per-repo session-id persistence
```

## How a task runs

1. You message Takt in any chat and ask for code work.
2. Takt decides a `agent_task` is warranted and dispatches an instruction to your daemon.
3. The daemon runs it through Claude Code (one resumed session per repo), streaming results back.
4. Takt reads the result and **decides what's next** — another round, or done (up to 30 rounds).
5. When done, Takt writes the final message to you in the chat.

Gated two ways (both must hold): your daemon is connected (routed per-user via the `/agent`
registry) **and** the `takt-director-enabled` PostHog kill switch is on.

## The review gate

Default `permissionMode: 'acceptEdits'` — file edits auto-stage (you review the local diff yourself).
The Session flags risky/outbound tools (`git push`/`commit`, `rm -rf`, `deploy`, `npm publish`, …);
in tool mode the server **auto-denies** them — so Claude can edit your working tree but can't commit,
push, or deploy. You review `git diff` and push when satisfied.

## Local dev

Point the daemon at your local server and run both:

```bash
# server:   cd ../server && npm run dev          (:3001)
# daemon:   TAKT_SERVER_URL=http://localhost:3001 npm run dev
```

Same code path as prod — only the server URL differs.

## Status

Typechecks clean against the installed SDKs. The daemon logs in, dials the server's `/agent`
namespace, and registers; the server routes `agent_task` dispatches per user. Remaining before a full
live run: enable the `takt-director-enabled` flag, deploy the server, and run a real task end-to-end.
Image/screenshot artifacts and an interactive (non-auto-deny) review gate are future work.
