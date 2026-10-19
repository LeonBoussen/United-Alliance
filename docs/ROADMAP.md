# Roadmap

Each phase ends with something that runs end to end.

## Phase 0 — Foundations ✅ (this commit)
- [x] DESIGN.md, CODE.md, PROTOCOL.md, DATA_MODEL.md, UI.md
- [x] Monorepo (npm workspaces), shared `@alliance/protocol` types
- [x] Web console scaffold with mock backend: Overview, Overseer, Agents, Agent detail, Tasks, Monitoring

## Phase 0.5 — Settings, network, providers ✅
- [x] Settings page in the console (network exposure, provider keys, credential delivery)
- [x] Network guard (`apps/overseer/src/security/network.ts`) with tests: private-only by default
- [x] Provider registry: DeepSeek available; Anthropic, OpenAI marked "later"
- [x] Chain of command in the console: insert thought, thought window, agent questions with Overseer timeout, Needs-you panel
- [x] `start.cmd` demo launcher

## Phase 0.6 — Teams and site-built agents ✅
- [x] Teams: protocol, design (§5c), Teams page, sidebar team switcher scoping every page
- [x] New agent wizard: generate a Windows/Linux build (zip + one-line installer) or push to an existing harness
- [x] `packages/harness-kit`: build generator (tests)
- [x] `apps/harness`: Python harness: enrollment, connection, agent loop, DeepSeek adapter, tools with policy (unit tests + e2e against a fake overseer and fake DeepSeek)

## Phase 1a — Working backend ✅
- [x] Overseer: SQLite storage, encrypted keys, console + harness WebSockets, network guard on HTTP and WS
- [x] Enrollment, build download + install scripts, DeepSeek gateway with usage recording and task budgets
- [x] Scheduler, Overseer agent on DeepSeek (chat, delegation, agent questions, escalations), thought windows, approvals
- [x] Harness self-update with rollback; `update_self` tool; automatic/manual update mode
- [x] End-to-end on Windows: site build → start.cmd → enroll → tasks via gateway → update → restart (fake DeepSeek)

## Phase 1c — Hosts, workers, helper, board ✅
- [x] Long runs no longer fail on the context limit: compaction + overflow recovery in the harness, trimming in the Overseer/helper loops
- [x] One active harness per folder; extra copies wait in standby and take over
- [x] Harness = host with seats; the Overseer spawns agents with roles, retires failed/cancelled/idle ones, spawns per task role
- [x] Follow-ups: the Overseer acts on finished/failed tasks by itself (rate-limited)
- [x] Helper between the Overseer and the operator, with guidance
- [x] Message board for agents, Overseer, helper and operator, with @mentions

## Phase 1b — Hardening (next)
- [ ] Try against the real DeepSeek API (the e2e used a fake endpoint) and tune prompts
- [ ] Operator login (required before public access can be enabled)
- [ ] Resume runs from checkpoints instead of restarting tasks after a disconnect
- [ ] Context-limit summarisation in the harness; DeepSeek thinking mode
- [ ] LLM-written dossier digests (today: deterministic updates from task results)
- [ ] Provider pricing → cost metrics (today: tokens only, cost shows $0)
- [ ] Run the Linux build end-to-end on a Linux machine
- [ ] Postgres option for larger installs
- [ ] Model Gateway `/gateway/deepseek` (pass-through + usage recording)
- [ ] DeepSeek adapter + agent loop with `report_progress` and a `shell` tool (policy `ask`)
- [ ] Console switches from mock to real backend (`VITE_OVERSEER_URL`)

**Exit:** operator creates a task in the console, a harness runs it, events stream live.

## Phase 2 — Overseer agent and context
- [ ] Overseer agent loop per operator thread; tools `list_agents`, `create_task`, `message_agent`, `get_dossier`
- [ ] Dossier digest worker; shared memory with pgvector; briefing compiler
- [ ] `ask_overseer` / `request_context` alliance tools
- [ ] Direct operator ↔ agent threads with `run.inject`

**Exit:** operator asks the Overseer for something; it delegates to the right agent and reports back with context.

## Phase 3 — Long-running and concurrent
- [ ] Leases, reaper, checkpoints, resume from checkpoint, outbox replay
- [ ] Multiple concurrent runs per agent, lock keys
- [ ] Pause / resume / cancel / retry; budgets; compaction; task budgets
- [ ] Approvals end to end (inbox in console)
- [ ] Subtasks, dependencies, scheduled + cron tasks

**Exit:** kill a harness mid-task; the task resumes from its checkpoint on restart.

## Phase 4 — Monitoring and polish
- [ ] Metrics rollup, Prometheus endpoint, OTel traces
- [ ] Run trace view (turn timeline), event log search
- [ ] Alerts + push notifications
- [ ] Command palette, keyboard navigation, settings pages (agents, policies, budgets)
- [ ] Auth: operator login, harness token management

## Phase 5 — More providers
- [ ] Anthropic adapter (Claude; compaction, adaptive thinking, mid-conversation system messages)
- [ ] OpenAI adapter
- [ ] Per-agent provider choice in the console

## Later
- Peer agent threads, multi-operator presence, artifact store, mobile approvals.
