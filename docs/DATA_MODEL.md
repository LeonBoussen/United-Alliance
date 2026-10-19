# Data Model

PostgreSQL 16 with `pgvector`. Managed with Drizzle migrations in
`apps/overseer/src/db`. Column names are `snake_case`; the wire uses `camelCase`.
All `id` columns are prefixed ULIDs (`text`). All times are `timestamptz`.

```
teams 1─* agents, tasks, threads
harnesses 1─* agents 1─* runs *─1 tasks *─1 threads 1─* messages
                 │                  │
                 1                  *─ task_deps
              dossiers (versioned)  │
                                    runs 1─* checkpoints
events (global log)  usage (per model call)  memories  approvals  metrics_minute
board_threads 1─* board_posts      helper_guidance      harness_builds (one per host)
```

## Tables

### harnesses
| Column | Type | Notes |
|---|---|---|
| id | text pk | `hrn_…` |
| name | text | |
| host | text | hostname reported in `hello` |
| token_hash | text | argon2 |
| version | text | |
| capabilities | text[] | |
| slots_total | int | |
| status | text | `online` · `degraded` · `offline` |
| last_heartbeat_at | timestamptz | |
| load | jsonb | `{cpu, memMb}` |
| created_at, revoked_at | timestamptz | |

### teams
| Column | Type | Notes |
|---|---|---|
| id | text pk | `team_…` |
| name | text | unique |
| mission | text | |
| color | text | hex accent for the console |
| lead_instructions | text null | extra overseer rules for this team |
| default_provider, default_model | text null | |
| budget_daily_tokens, budget_daily_usd | numeric null | |
| created_at, archived_at | timestamptz | |

### harness_builds
| Column | Type | Notes |
|---|---|---|
| id | text pk | `bld_…` |
| os | text | `windows` · `linux` |
| harness_name | text | the host's name; a build is a host, agents are spawned later |
| overseer_url | text | baked into `alliance.json` |
| enrollment_token_hash | text | single-use |
| status | text | `pending` · `enrolled` · `expired` · `revoked` |
| harness_id | text fk null | set on enrollment |
| created_by | text | |
| created_at, expires_at, enrolled_at, revoked_at | timestamptz | |

### agents
| Column | Type | Notes |
|---|---|---|
| id | text pk | `agt_…`; spawned by the Overseer (or by hand) onto a host |
| harness_id | text fk | the host it runs on |
| origin | text | `overseer` (retired automatically) · `operator` |
| team_id | text fk | |
| instructions | text null | |
| name, role | text | |
| provider | text | `deepseek` (v1) · `anthropic` · `openai`; null = settings default |
| model | text | null = provider default (`deepseek-flash`) |
| thinking | boolean | provider thinking/reasoning mode on |
| effort | text | `low`…`max` (mapped per provider) |
| tools | text[] | |
| max_concurrent_runs | int | |
| status | text | `idle` · `busy` · `waiting` · `offline` · `error` · `retired` |
| tool_grants | jsonb | `[{name, policy}]` |
| created_at, retired_at | timestamptz | |
| retire_reason | text null | e.g. "its run failed: …", "idle for 30 minutes" |

### threads
| Column | Type | Notes |
|---|---|---|
| id | text pk | `thr_…` |
| kind | text | `operator_overseer` · `overseer_agent` (no operator ↔ agent threads; see DESIGN §5b) |
| team_id | text fk null | operator_overseer: team the conversation is about; null = fleet-wide |
| title | text | |
| agent_id | text fk null | for agent threads |
| task_id | text fk null | thread that belongs to a task |
| created_at, updated_at, archived_at | timestamptz | |

### messages
| Column | Type | Notes |
|---|---|---|
| id | text pk | `msg_…` |
| thread_id | text fk | index `(thread_id, created_at)` |
| role | text | `operator` · `overseer` · `agent` · `system` · `tool` |
| author_id | text | operator id, `overseer`, or agent id |
| content | text | rendered text |
| kind | text | `chat` · `thought` (operator insert) · `reply` / `question` (agent → operator in a thought window) · `escalation` (overseer → operator) |
| resolved_at | timestamptz null | questions/escalations: when answered |
| answer_deadline | timestamptz null | agent questions: when the overseer takes over |
| answered_by | text null | `operator` · `overseer` |
| answers_message_id | text null | the question/escalation this message answers |

### thought_windows
| Column | Type | Notes |
|---|---|---|
| agent_id | text pk | one open window per agent |
| opened_at | timestamptz | |
| open_until | timestamptz | extended by new thoughts / operator answers |
| blocks | jsonb null | raw content blocks when relevant |
| run_id | text null | |
| created_at | timestamptz | |

### tasks
| Column | Type | Notes |
|---|---|---|
| id | text pk | `tsk_…` |
| parent_task_id | text fk null | |
| team_id | text fk | |
| thread_id | text fk | where the task is discussed |
| title, description | text | |
| acceptance | text null | acceptance criteria |
| status | text | see DESIGN §6.1 |
| priority | text | `low` · `normal` · `high` · `urgent` |
| agent_id | text fk null | assigned/preferred agent |
| progress | real null | 0..1 |
| progress_note | text null | |
| budget_tokens, budget_usd, budget_seconds | numeric null | |
| used_tokens, used_usd | numeric | rolled up from usage |
| max_attempts | int | default 3 |
| not_before | timestamptz null | |
| cron | text null | recurring template |
| result | jsonb null | |
| created_at, updated_at, started_at, finished_at | timestamptz | |

### task_deps
`task_id` → `depends_on_task_id` (composite pk).

### runs
| Column | Type | Notes |
|---|---|---|
| id | text pk | `run_…` |
| task_id | text fk | |
| agent_id | text fk | |
| attempt | int | |
| status | text | |
| lease_harness_id | text null | |
| lease_expires_at | timestamptz null | index for reaper |
| last_seq | int | highest event seq persisted |
| turn | int | |
| error | jsonb null | `{code, message}` |
| started_at, ended_at | timestamptz | |

### checkpoints
| Column | Type | Notes |
|---|---|---|
| run_id | text fk | pk `(run_id, seq)` |
| seq | int | |
| turn | int | |
| message_count | int | length of the run log after this checkpoint |
| messages | jsonb | **delta** (messages appended since previous checkpoint) |
| usage | jsonb | |
| note | text null | |
| created_at | timestamptz | |

Rebuilding a run log = concatenating `messages` of all checkpoints in `seq` order.

### events
| Column | Type | Notes |
|---|---|---|
| seq | bigserial pk | global order |
| id | text unique | `evt_…` |
| ts | timestamptz | |
| level | text | `debug` · `info` · `warn` · `error` |
| source_kind, source_id | text | |
| type | text | e.g. `run.tool.call`, `task.status`, `harness.offline` |
| run_id, task_id, agent_id, thread_id | text null | indexed |
| summary | text | one line, human-readable |
| data | jsonb | |

Partitioned by month. `debug` events are kept 7 days; others 180 days (configurable).

### dossiers
| Column | Type | Notes |
|---|---|---|
| agent_id | text fk | pk `(agent_id, version)` |
| version | int | |
| summary | text | |
| current_focus | text | |
| recent_results | jsonb | `[{taskId, outcome, note}]` |
| known_facts | text[] | |
| open_questions | text[] | |
| source_seq | bigint | last event seq digested |
| created_at | timestamptz | |

### memories
| Column | Type | Notes |
|---|---|---|
| id | text pk | `mem_…` |
| kind | text | `fact` · `decision` · `artifact` · `preference` · `reference` |
| content | text | |
| embedding | vector(1024) | |
| tags | text[] | |
| scope | text | `global` or `team:<id>` (DESIGN §5c) |
| source | jsonb | `{agentId?, taskId?, runId?, operator?}` |
| created_at, retired_at | timestamptz | |

### board_threads
| Column | Type | Notes |
|---|---|---|
| id | text pk | `bth_…` |
| board | text | `general` · `work` · `help` · `results` |
| no | int | number of the opening post |
| subject | text | |
| author_kind, author_id, author_name | text | `agent` · `overseer` · `helper` · `operator` |
| reply_count | int | |
| team_id, task_id | text null | |
| created_at, bumped_at | timestamptz | listed by `bumped_at` desc |

### board_posts
| Column | Type | Notes |
|---|---|---|
| id | text pk | `bpo_…` |
| no | int unique | global, increasing; `>>no` quotes a post |
| thread_id | text fk | |
| board | text | |
| author_kind, author_id, author_name | text | |
| content | text | `@Name` mentions are delivered to that agent's run |
| created_at | timestamptz | |

### helper_guidance
| Column | Type | Notes |
|---|---|---|
| id | text pk | `gdn_…` |
| content | text | a standing instruction from the operator to the helper |
| created_at, removed_at | timestamptz | |

### approvals
| Column | Type | Notes |
|---|---|---|
| id | text pk | `apr_…` |
| run_id | text fk | |
| tool_name | text | |
| input | jsonb | |
| reason | text | |
| risk | text | |
| status | text | `pending` · `approved` · `denied` · `expired` |
| decided_by, note | text null | |
| created_at, decided_at, expires_at | timestamptz | |

### usage
One row per model call (from the gateway, or self-reported by the harness in direct mode).
`id, ts, agent_id, run_id, task_id, provider, model, input_tokens, output_tokens,
cache_read_tokens, cache_write_tokens, cost_usd, ttft_ms, duration_ms, finish_reason,
reported_by ('gateway' | 'harness')`.

### settings
Key/value, one row per top-level group.
| Column | Type | Notes |
|---|---|---|
| key | text pk | `network` · `credentials` · `providers` |
| value | jsonb | see DESIGN §5a.3 |
| updated_by | text | operator id |
| updated_at | timestamptz | |

### provider_credentials
| Column | Type | Notes |
|---|---|---|
| provider | text pk | `deepseek` · `anthropic` · `openai` |
| ciphertext | bytea | AES-256-GCM |
| iv | bytea | 12 bytes, new per write |
| auth_tag | bytea | |
| key_hint | text | e.g. `sk-…a1b2` (shown in console) |
| updated_by | text | |
| updated_at | timestamptz | |

The master key comes from `ALLIANCE_MASTER_KEY` or a key file created in the data
directory on first boot. The plaintext key is never stored, logged or returned by the API.

### gateway_tokens
| Column | Type | Notes |
|---|---|---|
| id | text pk | `uag_…` prefix of the token |
| harness_id | text fk | |
| token_hash | text | |
| expires_at | timestamptz | default 1 h |
| revoked_at | timestamptz null | |

### metrics_minute
`minute (pk), agents_online, runs_active, tasks_queued, tokens, cost_usd,
tool_calls, errors, p50_latency_ms, p95_latency_ms`.

## Removing all data

**Settings → Remove all data** (`data.reset`) empties both tables, closes the database and
deletes `overseer.db` (with its `-wal`/`-shm` files) and `master.key` from the data
directory, then exits with code 75. `npm start` runs the Overseer under a small
supervisor (`src/supervisor.ts`) that starts it again, so it boots as on first start:
default settings, a fresh master key, team Main. Hosts lose their enrollment tokens and
must be added again. A master key from `ALLIANCE_MASTER_KEY` is left alone.
