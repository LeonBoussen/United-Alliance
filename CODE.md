# United Alliance — Code Guide

How the code is organised and the rules we follow. Read [DESIGN.md](DESIGN.md) first
for the why; this file is the how.

---

## 1. Repository layout

```
united-alliance/
├── DESIGN.md                 system design (architecture, context, long-running tasks)
├── CODE.md                   this file
├── README.md                 quick start
├── start.cmd                 Windows launcher: server, demo console, or console only
├── docs/
│   ├── PROTOCOL.md           WebSocket + REST contract (harness ↔ overseer ↔ console)
│   ├── DATA_MODEL.md         database tables
│   ├── UI.md                 console design language and screen specs
│   └── ROADMAP.md            build phases
├── packages/
│   ├── protocol/             shared TypeScript types for entities and wire messages
│   │   └── src/
│   │       ├── entities.ts   Team, Agent, Harness, Thread, Message, Task, Run, Event, …
│   │       ├── wire.ts       Envelope + every WS message type
│   │       └── index.ts
│   └── harness-kit/          generates harness builds (zip + install scripts) for Windows/Linux
└── apps/
    ├── web/                  operator console (React + Vite)   ← scaffolded
    ├── overseer/             server (Fastify, Postgres, agent)  ← network guard + provider registry so far
    └── harness/              client, Python (agent host, tools) ← first version
```

Planned internal structure of the two services:

```
apps/overseer/src/            (run: npm run start -w @alliance/overseer, or start.cmd → 1)
├── supervisor.ts             npm start entry: runs main.ts, starts it again when it exits 75 (data reset)
├── main.ts                   boot: storage, hubs, network guard, HTTP + WS upgrade, metrics, file watcher, data reset
├── config.ts                 ALLIANCE_* environment variables
├── db.ts                     node:sqlite document store + event log (data/overseer.db)
├── secrets.ts                AES-256-GCM for provider keys and build tokens (data/master.key)
├── core.ts                   in-memory state, persistence, broadcast, settings, harness source hash
├── ui-hub.ts                 console WebSocket: snapshot, commands
├── harness-hub.ts            harness WebSocket: enrollment, credentials, runs, questions, approvals, updates
├── scheduler.ts              task creation + assignment (spawns a worker when none fits), briefings
├── workers.ts                spawning agents onto host seats, retiring them, idle/offline reaper
├── board.ts                  the message board: threads, posts, @mention delivery, views for models
├── llm.ts                    tool loop shared by the Overseer and helper, context-window trimming
├── overseer-agent.ts         the Overseer LLM: operator chat, staffing, agent questions, follow-ups
├── helper-agent.ts           the helper LLM: answers the Overseer for the operator, guidance, escalations
├── http.ts                   gateway, builds/installers, update package, console static files
├── providers/registry.ts     provider definitions (base URLs, models)
└── security/network.ts       network guard (private-only by default)

apps/harness/                 Python 3.10+, shipped inside site-generated builds
├── requirements.txt          websockets, openai
├── tests/                    unittest (python -m unittest)
└── harness/
    ├── __main__.py           python -m harness (waits in standby if another copy runs in the folder)
    ├── instance.py           single-instance lock per install folder
    ├── config.py             alliance.json + .alliance-state (enrollment → permanent token)
    ├── connection.py         ws client, hello/welcome, heartbeat, outbox, reconnect, request/reply
    ├── host.py               the host: agents the Overseer spawned here, seats, run dispatch
    ├── runtime.py            provider-neutral agent loop, injection, checkpoints, overflow recovery
    ├── context.py            history compaction to stay inside the model's context window
    ├── adapters/deepseek.py  DeepSeek (OpenAI-format) adapter
    └── tools.py              tool registry + policy; shell/fs tools; alliance tools
```

---

## 2. Getting started

Requirements: Node 22.5+ (24 tested; `node:sqlite` needs 22.5), npm 10+. Python 3.10+ for the harness.

```bash
npm install            # installs all workspaces
npm run dev            # starts the web console on http://localhost:5173 (mock backend)
npm run build          # type-checks and builds all workspaces
npm run typecheck
```

The console uses a **mock backend** unless `VITE_OVERSEER_URL` is set
(e.g. in `apps/web/.env.local`):

```
VITE_OVERSEER_URL=http://localhost:8080
```

---

## 3. Language and style

- **TypeScript strict** everywhere (`strict`, `noUncheckedIndexedAccess`). No `any`;
  use `unknown` and narrow.
- **ESM only.** `import`/`export`, no `require`. No `__dirname` — use `import.meta.url`.
- **Naming:** `camelCase` for values and functions, `PascalCase` for types and React
  components, `SCREAMING_SNAKE` for constants, `kebab-case` for non-component files,
  `PascalCase.tsx` for component files.
- **Wire and DB names:** JSON fields are `camelCase`; DB columns are `snake_case`
  (Drizzle maps them). Message `type` strings are `dot.case` (`run.assign`).
- **IDs:** prefixed ULIDs — `agt_…`, `hrn_…`, `thr_…`, `msg_…`, `tsk_…`, `run_…`,
  `evt_…`. The prefix makes logs readable and catches mix-ups.
- **Times:** ISO-8601 UTC strings on the wire, `timestamptz` in the DB.
- **Formatting:** Prettier defaults (2 spaces, double quotes, trailing commas).
- **Comments** explain *why*, not *what*. Keep them short.

## 4. Boundaries and validation

- Every value that crosses a process boundary (REST body, WS message, tool input,
  env var, config file) is validated at the edge (zod in TS, explicit checks in Python). Inside the process, trust
  the types.
- Shared shapes live in `packages/protocol`. Never redefine a protocol type locally.
- Changing a wire message is a protocol change: update `wire.ts`, `docs/PROTOCOL.md`,
  and bump `PROTOCOL_VERSION` if it is not backward compatible.

## 5. Errors and logging

- Throw typed errors (`class LeaseExpiredError extends AllianceError`) with a stable
  `code`. Never match on error message text.
- Provider errors: catch most-specific first using the SDK's error classes (e.g. the
  `openai` SDK's `RateLimitError`, `AuthenticationError`, `APIError`) and map them to
  neutral codes (`rate_limited`, `auth`, `overloaded`, `bad_request`). Retry only what is
  retryable.
- Logs are structured (pino) with `runId`, `taskId`, `agentId` bound into child
  loggers. Anything an operator should see is an **event**, not just a log line.

## 6. Working with model providers

General rules (all providers):

- **Never read API keys from local config or env in the harness.** Model access comes
  from the overseer (`welcome` / `credentials.update`) and is kept in memory. Only the
  overseer reads `ALLIANCE_*_API_KEY` env vars, as a boot-time override.
- Never log keys or gateway tokens; redact `Authorization` headers in request logs.
- The agent loop only speaks the neutral model (`runtime/types.ts`). Provider
  specifics stay inside `runtime/adapters/<provider>.ts`.
- History is append-only; append the full assistant turn (text, tool calls, reasoning
  fields the provider requires) every turn.
- Stream every request. Validate tool-call arguments with the tool's zod schema before
  running; parse JSON with `JSON.parse`, never by string matching.
- Return one tool result per tool call id, all before the next request. Failed tools
  return an error result, they are not dropped.

**DeepSeek (v1):**

- OpenAI-format API: use the `openai` npm SDK with
  `baseURL` = the value from the overseer (gateway URL, or `https://api.deepseek.com`
  in direct mode) and `apiKey` = the token/key from the overseer.
- Models: `deepseek-flash` (default) and `deepseek-v4-pro`. The legacy names
  `deepseek-chat` / `deepseek-reasoner` are deprecated; don't use them. Keep model
  names in the provider registry, not in code, so they can be changed from Settings.
- Thinking mode (`thinking: {type: "enabled"}`) and `reasoning_effort` are request
  options set per agent.
- No server-side compaction: the harness summarises older turns when a run nears the
  context limit (DESIGN §4.2.1).

**Anthropic / OpenAI (later):** each gets its own adapter using its official SDK
(`@anthropic-ai/sdk`, `openai`). Notes for the Anthropic adapter are kept in the
adapter file when it is written.

## 7. Adding things

### A new harness tool

1. In `apps/harness/harness/tools.py`, write an `async def` taking `(args, ctx)` that
   returns a string, and register it as `Tool(name, description, schema, default_policy, fn)`.
2. `ctx` has `run_id`, `tool_call_id` (use as idempotency key) and `emit(event)`.
3. Register it in `TOOLS` in `harness/tools.py` and add it to the catalog the site offers
   in the console (`apps/web/src/lib/tool-catalog.ts`; used by Settings → Workers).
4. Default policy for anything destructive or outward-facing is `ask`.

### A new model provider

1. Add the provider to `ProviderId` in `packages/protocol/src/entities.ts`.
2. Add an entry (base URL, models, auth style, pricing) to
   `apps/overseer/src/providers/registry.ts`.
3. Add a gateway route `/gateway/<id>/…`.
4. Write `apps/harness/src/runtime/adapters/<id>.ts` implementing the adapter interface.
5. Flip its `available` flag so it can be enabled in Settings.

### A new console page

1. Add `apps/web/src/pages/<Name>.tsx`.
2. Add a route in `src/App.tsx` and a nav entry in `src/components/Sidebar.tsx`.
3. Read live state with `useStore(selector)`; send commands with `realtime.send(...)`.
4. Use the design tokens in `src/styles/tokens.css`; don't hard-code colours.

### A new wire message

1. Add the type to `packages/protocol/src/wire.ts`.
2. Document it in `docs/PROTOCOL.md`.
3. Handle it on both sides and, for UI-visible effects, in `apps/web/src/lib/store.ts`.

## 8. Web console conventions

- State: one live store (`src/lib/store.ts`, built on `useSyncExternalStore`) fed by
  the realtime client. History pages fetch through `src/lib/api.ts`.
- Realtime: `src/lib/realtime.ts` picks the WebSocket client or the mock client.
  Pages never open sockets directly.
- Styling: plain CSS with tokens (`tokens.css`) and small utility classes
  (`global.css`). Components keep their styles next to their markup by class name
  prefix (`.chat-…`, `.agent-card-…`).
- Every status is shown as **icon/dot + text**, never colour alone.
- Charts: single-series SVG with hover tooltip; no dual axes.

## 9. Testing

- Unit: Vitest next to the code (`foo.test.ts`).
- Protocol: round-trip tests that every message in `wire.ts` validates with its zod schema.
- Harness: the agent loop is tested with a fake Model Gateway that replays recorded
  responses.
- Console: Playwright smoke tests against the mock backend.

## 10. Git

- Branches: `feat/…`, `fix/…`, `docs/…`, `chore/…`.
- Commits: Conventional Commits (`feat(web): add task board filters`).
- Every PR that changes behaviour updates the relevant doc in the same PR.
