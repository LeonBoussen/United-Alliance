# Protocol

Contract between the **harness**, the **Overseer** and the **web console**. Types live
in [`packages/protocol/src/wire.ts`](../packages/protocol/src/wire.ts); this document
explains them. Current version: **`PROTOCOL_VERSION = 1`**.

---

## 1. Envelope

Every WebSocket frame is a JSON envelope:

```jsonc
{
  "v": 1,                       // protocol version
  "id": "01JB…",                // unique per sender (ULID)
  "type": "run.event",          // message type (dot.case)
  "ts": "2026-10-19T10:00:00Z", // sender timestamp
  "replyTo": "01JA…",           // optional: id of the message this answers
  "payload": { }                // type-specific body
}
```

Requests that expect an answer (`context.request`, `approval.request`) are matched by
`replyTo`. All other messages are fire-and-forget; reliability comes from per-run
sequence numbers and acknowledgements (`ack`).

---

## 2. Harness channel — `wss://<overseer>/ws/harness`

### 2.1 Session lifecycle

```
Harness                                   Overseer
   │── hello {token, agents, resumableRuns} ──►│  authenticate, register agents
   │◄── welcome {harnessId, heartbeatMs} ──────│
   │◄── run.assign … (requeued / new runs) ────│
   │── heartbeat (every heartbeatMs) ─────────►│  renews leases of activeRunIds
   │── run.event / run.checkpoint / … ────────►│
   │◄── ack {runId, seq} ──────────────────────│  harness drops acked outbox items
```

If no heartbeat arrives for `3 × heartbeatMs`, the session is considered lost; leases
expire on their own timer (default 60 s).

### 2.2 Harness → Overseer

| Type | Payload | Notes |
|---|---|---|
| `hello` | `token?` or `enrollmentToken?`, `name, host, os, version, capabilities[], slots, resumableRuns: {runId, lastSeq}[]` | First frame. A new harness sends the single-use `enrollmentToken` from its build; afterwards the permanent `token`. Closes with 4401 on a bad, used, expired or revoked token. |
| `heartbeat` | `activeRunIds[], slotsUsed, load? {cpu, memMb}` | Renews leases. |
| `run.accepted` | `runId` | Ack of `run.assign`. Run → `running`. |
| `run.event` | `runId, seq, event: RunEvent` | Streamed activity (see 2.4). |
| `run.checkpoint` | `runId, seq, turn, messageCount, messages (delta since last), usage, progress?, note?, compacted?` | After every turn. Delta is append-only, except after a compaction (DESIGN §4.2.1): then `compacted: true` and `messages` is the whole new history, replacing what was stored. |
| `run.status` | `runId, status, result?, error? {code, message}` | Terminal or paused/waiting states. |
| `context.request` | `runId, kind: "memory"|"dossier"|"question", query, topK?` | Answered by `context.response`. |
| `approval.request` | `runId, toolName, input, reason, risk: "low"|"medium"|"high"` | Run → `waiting_approval`. The agent's grant can override `risk`; routed per DESIGN §5b.4. The `Approval` entity shows `stage` (overseer → helper → operator), `decidedBy`, `reviewNotes`, `note`. |
| `task.create` | `parentTaskId, title, description, agentHint?, priority?` | From the `create_subtask` tool. |
| `memory.add` | `runId, content, kind` | From the `remember` tool; stored in the agent's team memory scope. |
| `harness.update_request` | `runId?` | From the `update_self` tool. |
| `harness.update_status` | `status: downloading/applied/failed, sourceHash, error?` | Progress of a self-update. |
| `board.request` | `runId, action: "read", board?, threadNo?` or `runId, action: "post", content, board?, threadNo?, subject?` | From `board_read` / `board_post` (DESIGN §5e). Answered by `board.response`. |
| `operator.reply` | `runId, content, question` | From `reply_to_operator`. Only accepted during a thought window (DESIGN §5b.3); questions are answered by the operator, or by the Overseer after the timeout. |

### 2.3 Overseer → Harness

| Type | Payload | Notes |
|---|---|---|
| `welcome` | `harnessId, sessionId, heartbeatMs, leaseMs, harnessToken?, agents: AgentDefinition[], models: ModelAccess[]` | `harnessToken` only on enrollment; the harness stores it and drops the enrollment token. `agents` are the ones the Overseer spawned on this host (DESIGN §5f). |
| `agents.update` | `agents: AgentDefinition[]` | An agent was spawned, edited, moved or retired. Replaces the set; runs of agents no longer in it are cancelled. |
| `credentials.update` | `models: ModelAccess[]` | Sent on key change, setting change, or token refresh. Replaces the previous set. |
| `run.assign` | `run, task, agentId, briefing, resumeFrom? {seq, messages}` | Harness replies `run.accepted` or `run.status{failed}`. |
| `run.signal` | `runId, signal: "pause"|"resume"|"cancel"` | Pause takes effect at the next turn boundary; cancel aborts now. |
| `run.inject` | `runId, from: "overseer"|"operator_thought"|"operator_answer"|"overseer_answer"|"board", content, threadId, answersMessageId?, windowOpenUntil?` | Appended at the next turn boundary. `windowOpenUntil` = until when `reply_to_operator` is accepted. `board` = a board post that @mentions the agent. |
| `operator.rejected` | `runId, reason: "no_open_window"` | Reply to `operator.reply` outside a thought window. |
| `harness.update` | `version, sourceHash, sha256, size, url` | New harness code (DESIGN §4.5). Installed when no runs are active; harness exits 75 to restart. |
| `harness.update_info` | `current, latest, upToDate, scheduled` (with `replyTo`) | Answer to `harness.update_request`. |
| `run.drop` | `runId, reason` | Stale run (lease was reassigned). Harness stops and discards it. |
| `context.response` | `items: ContextItem[]` (with `replyTo`) | |
| `board.response` | `ok, text` (with `replyTo`) | Rendered board/thread for the model, or the result of a post. |
| `approval.response` | `approved, note?` (with `replyTo`) | |
| `ack` | `runId, seq` | Highest contiguous `seq` persisted. |

### 2.4 RunEvent kinds

| Kind | Fields | Stored long-term |
|---|---|---|
| `turn.start` | `turn` | yes |
| `text.delta` | `text` | no (batched to UI only) |
| `thinking.update` | `text` | summary only |
| `tool.call` | `toolUseId, name, input` | yes |
| `tool.result` | `toolUseId, ok, output (truncated), durationMs` | yes |
| `turn.end` | `turn, stopReason, usage` | yes |
| `progress` | `fraction?, note` | yes |
| `log` | `level, message` | `info`+ |
| `message` | `threadId, content` | yes (also becomes a thread Message) |

---

## 3. Console channel — `wss://<overseer>/ws/ui`

Authenticated with the operator session cookie.

### 3.1 Console → Overseer

| Type | Payload |
|---|---|
| `subscribe` | `topics: Topic[], sinceSeq?` |
| `unsubscribe` | `topics: Topic[]` |
| `message.send` | `threadId, content, answersMessageId?` — operator ↔ Overseer threads and the operator ↔ helper thread (`answersMessageId` answers an escalation) |
| `thread.create` | `kind: "operator_overseer", title?` |
| `thought.insert` | `agentId, content, answersMessageId?` — thought into an agent; opens/extends its thought window; can answer an agent question (DESIGN §5b.3) |
| `task.create` | `title, description, priority, teamId, agentId?, role?, budgetTokens?` — `role`: the kind of agent to use or spawn |
| `task.signal` | `taskId, signal: "pause"|"resume"|"cancel"|"retry"` |
| `approval.decide` | `approvalId, approved, note?` |
| `settings.update` | `patch` (see §5a) |
| `provider.setKey` | `provider, apiKey` (write-only) |
| `provider.test` | `provider` |
| `team.create` | `name, mission, color, leadInstructions?, defaultProvider?, defaultModel?, budget?` |
| `team.update` | `teamId, patch` |
| `agent.move` | `agentId, teamId` |
| `host.create` | `os, harnessName, overseerUrl` — generate a host build. Answered with `entity` build |
| `agent.spawn` | `teamId, role, name?, instructions?, harnessId?` — spawn an agent by hand (kept until retired by hand) |
| `agent.retire` | `agentId` |
| `agent.update` | `agentId, tools?: ToolGrant[] ({name, policy, risk?}), approvals?: {low?, medium?, high?}` — per-agent permissions; `approvals: {}` = follow the defaults |
| `board.post` | `board, content, threadId?, subject?` — reply, or start a thread with `subject` |
| `guidance.add` · `guidance.remove` | `content` · `id` — the helper's standing instructions |
| `build.revoke` | `buildId` |
| `harness.update` | `harnessId` (push the latest harness code now) |
| `data.reset` | `confirm: "delete all data"` — delete everything the Overseer stores and restart it. Consoles are closed with 1012, reconnect and get a fresh snapshot (event `seq` starts again at 1) |

### 3.2 Overseer → Console

| Type | Payload |
|---|---|
| `snapshot` | Full current state for the subscribed topics (sent on subscribe). |
| `event` | `SystemEvent` |
| `message` | `Message` (new or streaming update with `partial: true`) |
| `board.post` | `BoardPost` |
| `entity` | `{ kind: "agent"|"harness"|"task"|"thread"|"run"|"dossier"|"approval"|"settings"|"thoughtWindow"|"team"|"build"|"boardThread"|"guidance", entity }` (upsert; guidance with `removed: true` is deleted) |
| `metrics` | `MetricsSnapshot` |

### 3.3 Topics

`events` · `metrics` · `fleet` (agents + harnesses) · `tasks` · `thread:<id>` ·
`agent:<id>` · `task:<id>` · `run:<id>`

On reconnect the console re-subscribes with `sinceSeq` = last event `seq` it applied;
the Overseer replays missed events, or sends a fresh `snapshot` if the gap is too big.

---

## 4. REST — `https://<overseer>/api`

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness. |
| `GET` | `/agents` · `/agents/:id` | Agents. |
| `GET` | `/agents/:id/dossier` | Current dossier (`?version=` for history). |
| `GET` | `/harnesses` | Harnesses + health. |
| `POST` | `/harnesses/tokens` | Issue a harness token. |
| `GET` `POST` | `/threads` | List / create threads. |
| `GET` | `/threads/:id/messages?before=&limit=` | Paged history. |
| `GET` `POST` | `/tasks` | List (filters: status, agent) / create. |
| `GET` | `/tasks/:id` · `/tasks/:id/runs` | Task detail, runs. |
| `POST` | `/tasks/:id/signal` | Pause / resume / cancel / retry. |
| `GET` | `/runs/:id/events?afterSeq=` | Run trace. |
| `GET` | `/events?level=&source=&q=&before=` | Event log search. |
| `GET` | `/metrics?from=&to=&step=` | Metric series. |
| `GET` `POST` | `/approvals` · `/approvals/:id/decide` | Approvals. |
| `GET` `POST` | `/memory` | Search / add shared memory. |
| `GET` `POST` `PATCH` | `/teams` · `/teams/:id` | Teams. |
| `GET` | `/builds` · `/builds/:id` | Host builds and their status. |
| `GET` | `/builds/:id/download?t=` | Zip for the build's OS. |
| `GET` | `/builds/:id/install.ps1?t=` · `/builds/:id/install.sh?t=` | One-line installers: download, unpack, run `start.*`. Only served over private networks or HTTPS. |
| `POST` | `/builds/:id/revoke` | Revoke an unused build. |
| `GET` | `/harness/package` | Update package (harness code only). `Authorization: Bearer <harness token>`; headers `x-source-hash`, `x-sha256`. |
| `GET` `PATCH` | `/settings` | Read / update server settings (keys excluded). |
| `PUT` `DELETE` | `/settings/providers/:id/key` | Set / clear a provider API key (write-only). |
| `POST` | `/settings/providers/:id/test` | Test a provider connection. |

Every HTTP route, WebSocket upgrade and gateway call passes the network guard first
(DESIGN §10.1): requests from outside loopback/private ranges get `403` unless
public access is enabled.

## 5. Model access and the gateway

The Overseer gives each harness a `ModelAccess` entry per enabled provider, in
`welcome` and again in `credentials.update` whenever something changes:

```jsonc
{
  "provider": "deepseek",
  "delivery": "gateway",                         // or "direct"
  "baseUrl": "http://192.168.1.20:8080/gateway/deepseek",  // direct: https://api.deepseek.com
  "token": "uag_…",                              // direct: the real API key
  "expiresAt": "2026-10-19T11:00:00Z",           // gateway tokens only; refreshed before expiry
  "defaultModel": "deepseek-flash",
  "models": ["deepseek-flash", "deepseek-v4-pro"],
  "contextWindow": 128000                        // the harness compacts runs before reaching it
}
```

The harness builds its provider client from it, e.g. for DeepSeek:

```ts
const client = new OpenAI({ baseURL: access.baseUrl, apiKey: access.token });
```

and adds `x-alliance-run: <runId>` on each request. In gateway mode
(`/gateway/<provider>/…`) the Overseer checks the token, applies budgets and rate
limits, swaps in the real key, forwards the request unchanged, and records usage from
the response. Error shapes are passed through so SDK error classes work. A provider
with no key set returns `401` with `{"error":{"code":"credentials_missing"}}`.

## 5a. Settings (console channel)

Settings travel as an `entity` update with `kind: "settings"` and are included in the
`snapshot`. Provider keys are **never** sent to the console — only `keySet` and
`keyHint`.

| Console → Overseer | Payload | Notes |
|---|---|---|
| `settings.update` | `patch: SettingsPatch` | Network, delivery, default provider, per-provider `enabled` / `defaultModel` / `baseUrl`, `workers` (`maxAgents`, `idleRetireMinutes`, `effort`, `defaultTools`), `autonomy` (`followUps`, `maxFollowUpsPerHour`), `approvals` (`low` / `medium` / `high` → `approve` · `overseer` · `operator`). |
| `provider.setKey` | `provider, apiKey` | Write-only. Empty string clears the key. |
| `provider.test` | `provider` | Result arrives as an event `provider.test` (`info` ok / `error` with message). |

Rules enforced by the Overseer: `network.allowPublic: true` is rejected unless the
request came from loopback/private and operator login is configured. A setting locked
by an env var is rejected with an `error` event.

## 6. Close codes

| Code | Meaning |
|---|---|
| 4400 | Malformed message |
| 4401 | Bad or revoked token |
| 4409 | Duplicate session for this harness (older one is closed) |
| 4426 | Protocol version not supported |
