# Console UI

The operator console is a working tool used for hours at a time. It should feel calm,
dense and fast — closer to a flight deck than a marketing site.

## Principles

1. **Live by default.** Everything on screen updates in place. No refresh buttons.
2. **Glanceable status.** Every agent, harness, task and event shows its state as a
   dot/icon **and** a word. Colour is never the only signal.
3. **Talk anywhere.** Any agent or the Overseer is at most two clicks from a chat box.
4. **Density without noise.** Small type, tight rows, generous whitespace *between*
   groups, quiet borders. Accent colour only for what needs attention.
5. **Keyboard friendly.** `Enter` sends, `Shift+Enter` new line; planned `Ctrl+K` palette.

## Layout

```
┌────────────┬──────────────────────────────────────────────────────────┐
│ ◆ United   │  Page title                    ● 4/5 agents  3 runs  ◐   │
│   Alliance ├──────────────────────────────────────────────────────────┤
│            │                                                          │
│ Overview   │                                                          │
│ Overseer   │                     page content                         │
│ Agents     │                                                          │
│ Tasks      │                                                          │
│ Monitoring │                                                          │
│            │                                                          │
│ ● Live     │                                                          │
└────────────┴──────────────────────────────────────────────────────────┘
```

Sidebar collapses to icons under 900 px and to a top bar under 640 px.

## Tokens

Defined in `apps/web/src/styles/tokens.css`. Dark theme is the default; light is a
first-class alternative (`data-theme` on `<html>`, or system preference).

| Token | Use |
|---|---|
| `--bg`, `--surface`, `--surface-2`, `--border` | page, cards, raised/hover, dividers |
| `--text`, `--text-2`, `--text-3` | primary, secondary, muted ink |
| `--accent` | primary actions, selection, chart line |
| `--good`, `--warn`, `--bad`, `--info` | status (always with icon + label) |
| `--radius`, `--radius-sm` | 10px / 6px |
| `--font`, `--mono` | system UI stack / system monospace |

## Status vocabulary

| Entity | States |
|---|---|
| Agent | idle · busy · waiting · offline · error |
| Harness | online · degraded · offline |
| Task | queued · assigned · running · paused · waiting approval · succeeded · failed · cancelled |
| Event | debug · info · warn · error |

## Screen specs

- **Overview:** six KPI tiles; agent card grid (status, focus, run count, harness);
  active task list with progress; live event feed (newest first, capped at 200).
- **Overseer:** thread list · chat · **Needs you** (escalations, agent questions with
  a countdown to when the Overseer answers, approvals; answer inline) · fleet context.
- **Agents:** card grid with filters. **Agent detail:** header + tabs
  (Activity · Tasks · Dossier · Events). Activity is the agent's thread with an
  **Insert thought** composer and a banner showing whether the thought window is open.
  Thoughts are dashed blue, open questions amber, answered ones show who answered.
- **Team switcher** (sidebar, under the logo): "All teams" or one team. Scopes Overview,
  Overseer threads, Agents, Tasks and the event feed. Remembered per browser.
- **Teams:** team list · detail (mission, Overseer instructions, budget meter, edit),
  members with a move-to-team select.
- **Hosts** (`/hosts`): one card per host with a seat strip (used/free), its agents and
  status; **Add host** (Windows/Linux, name, Overseer URL) shows a build card: download
  zip, copyable one-line installer, status, revoke. Pending builds are listed below.
- **Agents:** filters include `retired`; **Spawn agent** (role, team, host, name,
  instructions). Agent detail has **Retire** and shows who spawned it.
- **Helper** (`/helper`): chat with the helper (escalations answered inline), Needs you,
  and the guidance list (add / remove).
- **Board** (`/board`): board tabs with thread counts, thread list by last bump, thread
  view with post numbers (click to quote), `>>123` links and `@Name` mentions, reply /
  new-thread composer.
- **Settings:** network access (public toggle, allowed ranges, listen address),
  model providers (write-only API key, default model, base URL, test), credential
  delivery (gateway / direct), chain of command (window and answer timeout), workers &
  autonomy (max agents, idle retirement, effort, default tool policies, follow-ups),
  remove all data (typed confirmation; the Overseer wipes its data and restarts empty).
- **Tasks:** status filter chips, new-task form, rows with progress bar, budget meter,
  actions.
- **Monitoring:** throughput / cost / active-run charts (single series, hover
  tooltip), harness health table, event log with level filter, text search and pause.
