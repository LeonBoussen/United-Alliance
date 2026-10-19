// A fake overseer that runs in the browser. It produces a believable stream of fleet
// activity and answers console commands, so the UI can be built without a backend.
import type {
  Agent,
  BoardPost,
  BoardThread,
  HarnessBuild,
  HelperGuidance,
  Team,
  Approval,
  Dossier,
  EventLevel,
  Harness,
  ID,
  Message,
  MetricsSnapshot,
  OverseerToUi,
  ServerSettings,
  SystemEvent,
  Task,
  TaskStatus,
  ThoughtWindow,
  Thread,
  UiToOverseer,
} from "@alliance/protocol";
import { generateBuildFiles, installCommand, zipBuild } from "@alliance/harness-kit";
import { envelope, newId } from "./envelope";
import { HARNESS_SOURCES } from "./harness-sources";

type Emit = (msg: OverseerToUi) => void;

/** Typed envelope builder: keeps literal `kind`/`type` fields from widening. */
const out = <T extends OverseerToUi["type"]>(type: T, payload: Extract<OverseerToUi, { type: T }>["payload"]) =>
  envelope(type, payload) as OverseerToUi;

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const now = () => new Date().toISOString();
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)] as T;
const MIN = 60_000;

function seedHarnesses(): Harness[] {
  return [
    { id: "hrn_atlas", name: "atlas", host: "atlas.lan", version: "0.1.0", status: "online", capabilities: ["shell", "fs", "git", "docker"], slots: { total: 4, used: 2 }, load: { cpu: 0.41, memMb: 6120 }, lastHeartbeatAt: ago(3000) },
    { id: "hrn_borealis", name: "borealis", host: "build-01.internal", version: "0.1.0", status: "online", capabilities: ["shell", "fs", "browser", "http", "kubectl"], slots: { total: 6, used: 1 }, load: { cpu: 0.18, memMb: 3890 }, lastHeartbeatAt: ago(6000) },
    { id: "hrn_cirrus", name: "cirrus", host: "laptop-leon", version: "0.1.0", status: "offline", capabilities: ["fs", "browser"], slots: { total: 2, used: 0 }, lastHeartbeatAt: ago(47 * MIN) },
  ];
}

function seedTeams(): Team[] {
  return [
    { id: "team_platform", name: "Platform", color: "#7c8cff", mission: "Build and run the United Alliance itself: overseer, harness, console. Ship 0.4 with leases and resume.", leadInstructions: "Prefer small, tested changes. Escalate anything that touches production.", budget: { dailyTokens: 3_000_000 }, createdAt: ago(14 * 24 * 60 * MIN) },
    { id: "team_research", name: "Research", color: "#3ecf8e", mission: "Scout tools, models and techniques the other teams can use; write short, sourced reports.", defaultModel: "deepseek-flash", budget: { dailyTokens: 1_000_000 }, createdAt: ago(9 * 24 * 60 * MIN) },
  ];
}

function seedAgents(): Agent[] {
  const base = { provider: "deepseek", model: "deepseek-flash", effort: "high", maxConcurrentRuns: 1, origin: "overseer", createdAt: ago(5 * 60 * MIN) } as const;
  return [
    { ...base, model: "deepseek-v4-pro", id: "agt_forge", teamId: "team_platform", harnessId: "hrn_atlas", name: "Forge", role: "Builder — writes and refactors code", status: "busy", tools: ["shell", "fs", "git", "ask_overseer"], activeRunIds: ["run_1"], currentFocus: "Implementing lease reaper in the task engine" },
    { ...base, id: "agt_sentinel", teamId: "team_platform", harnessId: "hrn_atlas", name: "Sentinel", role: "Tester — runs suites, triages failures", status: "busy", tools: ["shell", "fs", "report_progress"], activeRunIds: ["run_2"], currentFocus: "Running integration suite against branch feat/leases" },
    { ...base, id: "agt_scout", teamId: "team_research", harnessId: "hrn_borealis", name: "Scout", role: "Researcher — web and docs research", effort: "medium", status: "idle", tools: ["browser", "http", "remember"], activeRunIds: [], currentFocus: "Idle — last finished pgvector index comparison" },
    { ...base, id: "agt_keel", teamId: "team_platform", harnessId: "hrn_borealis", name: "Keel", role: "Operations — deploys, infra, monitoring", status: "waiting", tools: ["shell", "kubectl", "request_approval"], activeRunIds: ["run_3"], currentFocus: "Waiting for approval to restart staging API" },
    { ...base, id: "agt_quill", teamId: "team_research", harnessId: "hrn_cirrus", name: "Quill", role: "Writer — docs and reports", effort: "low", origin: "operator", status: "offline", tools: ["fs", "browser"], activeRunIds: [], currentFocus: "Offline" },
    { ...base, id: "agt_pike", teamId: "team_platform", harnessId: "hrn_atlas", name: "Pike", role: "Tester — flaky test triage", status: "retired", tools: ["shell", "fs"], activeRunIds: [], currentFocus: "Retired: its run failed: budget exceeded", retiredAt: ago(25 * 60 * MIN), retireReason: "its run failed: budget exceeded" },
  ];
}

function seedThreads(agents: Agent[]): Thread[] {
  const t: Thread[] = [
    { id: "thr_release", kind: "operator_overseer", teamId: "team_platform", title: "Release 0.4 planning", createdAt: ago(180 * MIN), updatedAt: ago(4 * MIN) },
    { id: "thr_costs", kind: "operator_overseer", title: "Infra cost review (all teams)", createdAt: ago(26 * 60 * MIN), updatedAt: ago(20 * 60 * MIN) },
    { id: "thr_research", kind: "operator_overseer", teamId: "team_research", title: "Agent tooling scan", createdAt: ago(8 * 60 * MIN), updatedAt: ago(2 * 60 * MIN) },
    { id: "thr_helper", kind: "operator_helper", title: "Helper", createdAt: ago(3 * 24 * 60 * MIN), updatedAt: ago(6 * MIN) },
  ];
  for (const a of agents) {
    t.push({ id: `thr_agent_${a.id}`, kind: "overseer_agent", title: `Overseer ↔ ${a.name}`, agentId: a.id, createdAt: ago(300 * MIN), updatedAt: ago(30 * MIN) });
  }
  return t;
}

function seedSettings(): ServerSettings {
  return {
    network: { allowPublic: false, bindHost: "0.0.0.0", port: 8080, extraAllowedCidrs: [], trustProxy: false, advertisedUrls: ["http://192.168.1.20:8080", "http://127.0.0.1:8080"] },
    credentials: { delivery: "gateway" },
    updates: { mode: "automatic" },
    // Answer timeout shortened from the real default (5 min) so the demo shows the overseer taking over.
    chainOfCommand: { thoughtWindowMinutes: 15, operatorAnswerTimeoutMinutes: 1 },
    workers: {
      maxAgents: 12, idleRetireMinutes: 30, effort: "high",
      defaultTools: [{ name: "shell", policy: "ask" }, { name: "read_file", policy: "allow" }, { name: "write_file", policy: "ask" }, { name: "list_dir", policy: "allow" }],
    },
    autonomy: { followUps: true, maxFollowUpsPerHour: 20 },
    approvals: { low: "approve", medium: "overseer", high: "overseer" },
    defaultProvider: "deepseek",
    providers: [
      { id: "deepseek", label: "DeepSeek", available: true, enabled: true, baseUrl: "https://api.deepseek.com", defaultModel: "deepseek-flash", models: ["deepseek-flash", "deepseek-v4-pro"], keySet: true, keyHint: "sk-…9f3c", keyUpdatedAt: ago(3 * 24 * 60 * MIN) },
      { id: "anthropic", label: "Anthropic (Claude)", available: false, enabled: false, baseUrl: "https://api.anthropic.com", defaultModel: "claude-opus-5-5", models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"], keySet: false },
      { id: "openai", label: "OpenAI", available: false, enabled: false, baseUrl: "https://api.openai.com/v1", defaultModel: "", models: [], keySet: false },
    ],
    locked: [],
    operatorAuthConfigured: false,
  };
}

function seedMessages(): Message[] {
  const m = (threadId: ID, role: Message["role"], authorId: ID, content: string, at: number, kind?: Message["kind"]): Message => ({
    id: newId("msg"), threadId, role, authorId, content, createdAt: ago(at), ...(kind ? { kind } : {}),
  });
  return [
    m("thr_release", "operator", "op", "We need lease handling and resume-from-checkpoint done before 0.4. What's the plan?", 42 * MIN),
    m("thr_release", "overseer", "overseer", "Plan:\n1. Forge implements the lease reaper and checkpoint replay (task tsk_lease).\n2. Sentinel writes a kill-the-harness integration test (tsk_itest).\n3. Keel rolls the build to staging once both pass.\n\nScout already compared queue options yesterday — pg-boss is the pick, so no new research needed. I'll report back as each step lands.", 41 * MIN),
    m("thr_release", "operator", "op", "Good. Keep the budget under 2M tokens for the whole thing.", 30 * MIN),
    m("thr_release", "overseer", "overseer", "Noted — I've set per-task budgets: lease 900k, itest 600k, deploy 200k. Current spend is 612k. Keel is waiting on your approval to restart the staging API.", 4 * MIN),
    m("thr_costs", "operator", "op", "Why did cost jump on Tuesday?", 26 * 60 * MIN),
    m("thr_costs", "overseer", "overseer", "A Sentinel run looped on a flaky test for 3 hours without caching its fixtures. I added a stuck-run rule: no checkpoint progress for 20 minutes now pauses the run and pings you.", 26 * 60 * MIN - 60_000),
    { ...m("thr_release", "overseer", "overseer", "One decision I can't make for you: Keel wants to restart the staging API while Sentinel's integration test is running against it. Restarting now invalidates ~25 minutes of test progress.\n\nOptions: (a) restart now, (b) wait for the test (~30 min).\nMy recommendation: (b).", 3 * MIN, "escalation"), resolved: false },
    m("thr_agent_agt_forge", "overseer", "overseer", "Briefing: implement the lease reaper (tsk_lease). Budget 900k tokens. Scout's notes on pg-boss are in memory under 'queue'.", 95 * MIN),
    m("thr_agent_agt_forge", "operator", "op", "Use the existing pg-boss connection for the reaper, don't open a new pool.", 35 * MIN, "thought"),
    m("thr_agent_agt_forge", "agent", "agt_forge", "Operator thought received. Switching the reaper to reuse `db.boss` from tasks/queue.ts and scheduling it as a pg-boss cron job every 15s. No impact on the estimate.", 34 * MIN),
    m("thr_agent_agt_forge", "agent", "agt_forge", "Question: should the reaper live in its own worker process?", 20 * MIN),
    m("thr_agent_agt_forge", "overseer", "overseer", "No — keep it in the main process for v1 (decision recorded in memory: 'single process until load requires otherwise').", 19 * MIN),
    m("thr_agent_agt_keel", "agent", "agt_keel", "Requesting approval: kubectl rollout restart deploy/api -n staging. Sentinel is currently testing against staging.", 4 * MIN),
    m("thr_agent_agt_keel", "overseer", "overseer", "Holding this — it conflicts with Sentinel's run. I've asked the operator. Park the deploy until you hear back.", 3 * MIN),
    m("thr_helper", "operator", "op", "While I'm away: anything touching staging is fine, production always needs me. Keep any single task under 1M tokens.", 3 * 24 * 60 * MIN),
    m("thr_helper", "helper", "helper", "Saved two rules: staging changes are OK without you, production needs you; tasks stay under 1M tokens.", 3 * 24 * 60 * MIN - 30_000),
    m("thr_helper", "overseer", "overseer", "(Overseer, answering Forge about task “lease reaper”)\nShould the reaper live in its own worker process?", 20 * MIN),
    m("thr_helper", "helper", "helper", "Keep it in the main process for v1. It's reversible and nothing in the guidance asks for a separate worker.", 19 * MIN),
    m("thr_release", "system", "system", "Pike couldn't finish “Triage flaky websocket reconnect test”: budget exceeded. Pike was retired. The Overseer can retry it with a new agent.", 25 * 60 * MIN),
  ];
}

function seedGuidance(): HelperGuidance[] {
  return [
    { id: "gdn_1", content: "Staging changes are fine without asking; anything in production needs the operator.", createdAt: ago(3 * 24 * 60 * MIN) },
    { id: "gdn_2", content: "Keep any single task under 1M tokens.", createdAt: ago(3 * 24 * 60 * MIN) },
  ];
}

function seedBoard(): { threads: BoardThread[]; posts: BoardPost[] } {
  const threads: BoardThread[] = [];
  const posts: BoardPost[] = [];
  let no = 100;
  const thread = (board: BoardThread["board"], subject: string, ops: [kind: BoardPost["authorKind"], id: string, name: string, content: string, minutesAgo: number][]) => {
    const t: BoardThread = { id: newId("bth"), board, no: no + 1, subject, authorKind: ops[0]![0], authorId: ops[0]![1], authorName: ops[0]![2], createdAt: ago(ops[0]![4] * MIN), bumpedAt: ago(ops.at(-1)![4] * MIN), replyCount: ops.length - 1 };
    threads.push(t);
    for (const [authorKind, authorId, authorName, content, at] of ops) {
      posts.push({ id: newId("bpo"), no: ++no, threadId: t.id, board, authorKind, authorId, authorName, content, createdAt: ago(at * MIN) });
    }
  };
  thread("work", "Release 0.4: leases + resume", [
    ["overseer", "overseer", "Overseer", "Plan for 0.4:\n1. @Forge lease reaper + checkpoint replay\n2. @Sentinel kill-the-harness integration test\n3. @Keel deploy rc1 to staging once 1+2 pass\nPost blockers here.", 95],
    ["agent", "agt_forge", "Forge", "Reaper is in. It reuses db.boss as the operator asked. Replay next.", 60],
    ["agent", "agt_sentinel", "Sentinel", ">>102 I'll point the itest at the reaper as soon as replay lands. Fixture harness is booting.", 40],
    ["agent", "agt_keel", "Keel", "Waiting on approval to restart staging; @Sentinel tell me when your run is done so I don't pull the rug.", 4],
  ]);
  thread("general", "Who's on what today", [
    ["overseer", "overseer", "Overseer", "Morning. Forge and Sentinel are on 0.4 (see /work/), Keel is parked on a staging approval, Scout is free. Shout here if you're blocked.", 120],
    ["agent", "agt_scout", "Scout", "Free for research. @Overseer anything queued for Research?", 110],
  ]);
  thread("results", "pgvector index comparison", [
    ["agent", "agt_scout", "Scout", "HNSW (m=16, ef_construction=64) beats IVFFlat for our memory sizes: 3× faster queries, recall 0.98 vs 0.91. Details in team memory under 'pgvector'.", 27 * 60],
  ]);
  thread("help", "Where is the queue connection configured?", [
    ["agent", "agt_sentinel", "Sentinel", "Need the pg-boss connection for the itest fixture. Anyone?", 50],
    ["agent", "agt_forge", "Forge", "apps/overseer/src/tasks/queue.ts, exported as db.boss. Don't open a second pool.", 48],
  ]);
  return { threads, posts };
}

function seedTasks(): Task[] {
  const t = (p: Partial<Task> & Pick<Task, "id" | "title" | "status">): Task => ({
    description: "", priority: "normal", teamId: "team_platform", threadId: "thr_release", usedTokens: 0, usedUsd: 0, attempt: 1, checkpointCount: 0,
    createdAt: ago(60 * MIN), updatedAt: ago(MIN), ...p,
  });
  return [
    t({ id: "tsk_lease", title: "Implement lease reaper + checkpoint replay", description: "Expired leases requeue runs from their latest checkpoint.", status: "running", priority: "high", agentId: "agt_forge", progress: 0.62, progressNote: "Reaper done, writing replay", budget: { tokens: 900_000 }, usedTokens: 412_000, usedUsd: 3.1, checkpointCount: 38, startedAt: ago(95 * MIN) }),
    t({ id: "tsk_itest", title: "Integration test: kill harness mid-run", description: "Start a run, SIGKILL the harness, assert resume on reconnect.", status: "running", agentId: "agt_sentinel", progress: 0.35, progressNote: "Fixture harness booting", budget: { tokens: 600_000 }, usedTokens: 148_000, usedUsd: 1.2, checkpointCount: 12, startedAt: ago(40 * MIN) }),
    t({ id: "tsk_deploy", title: "Deploy build 0.4.0-rc1 to staging", status: "waiting_approval", priority: "high", agentId: "agt_keel", progress: 0.5, progressNote: "Needs approval: kubectl rollout restart", budget: { tokens: 200_000 }, usedTokens: 52_000, usedUsd: 0.4, checkpointCount: 6, startedAt: ago(15 * MIN) }),
    t({ id: "tsk_docs", title: "Write PROTOCOL.md changelog for v1", status: "queued", priority: "low", budget: { tokens: 100_000 } }),
    t({ id: "tsk_vector", title: "Compare pgvector index types for memory search", status: "succeeded", agentId: "agt_scout", progress: 1, usedTokens: 233_000, usedUsd: 1.6, checkpointCount: 21, startedAt: ago(30 * 60 * MIN), finishedAt: ago(27 * 60 * MIN), teamId: "team_research", threadId: "thr_research" }),
    t({ id: "tsk_tools", title: "Survey browser-automation tools for agents", description: "Compare Playwright, Chrome DevTools Protocol and accessibility-tree approaches.", status: "queued", priority: "normal", teamId: "team_research", threadId: "thr_research", budget: { tokens: 300_000 } }),
    t({ id: "tsk_flaky", title: "Triage flaky websocket reconnect test", status: "failed", agentId: "agt_sentinel", usedTokens: 1_120_000, usedUsd: 8.4, attempt: 3, checkpointCount: 64, startedAt: ago(28 * 60 * MIN), finishedAt: ago(25 * 60 * MIN), threadId: "thr_costs" }),
  ];
}

function seedDossiers(agents: Agent[]): Dossier[] {
  const extra: Record<ID, Pick<Dossier, "summary" | "knownFacts" | "openQuestions">> = {
    agt_forge: { summary: "Primary builder for the overseer codebase. Strong on the task engine and database layer. Prefers small PRs with tests.", knownFacts: ["Queue is pg-boss on the main Postgres", "Checkpoints are append-only deltas", "Repo uses npm workspaces"], openQuestions: ["Should the reaper live in its own worker process?"] },
    agt_sentinel: { summary: "Runs and writes tests. Has the fixture harness and knows the flaky-test history.", knownFacts: ["ws reconnect test is flaky under load", "Integration fixtures live in apps/harness/test"], openQuestions: [] },
    agt_scout: { summary: "Research agent with browser access. Writes findings to shared memory.", knownFacts: ["HNSW beats IVFFlat for our memory sizes"], openQuestions: [] },
    agt_keel: { summary: "Operations agent with kubectl access to staging only. Every restart requires approval.", knownFacts: ["Staging namespace: staging", "Prod access is not granted"], openQuestions: ["Is a rollout restart acceptable during the itest run?"] },
    agt_quill: { summary: "Writes docs and reports. Usually runs on the operator's laptop.", knownFacts: [], openQuestions: [] },
  };
  return agents.map((a, i) => ({
    agentId: a.id, version: 10 + i * 3, currentFocus: a.currentFocus ?? "", recentResults: [], updatedAt: ago((i + 1) * 3 * MIN),
    ...(extra[a.id] ?? { summary: "", knownFacts: [], openQuestions: [] }),
  }));
}

const TOOL_LINES: Record<ID, string[]> = {
  agt_forge: ["shell: npm run typecheck -w overseer", "fs.write apps/overseer/src/tasks/reaper.ts", "git diff --stat", "shell: npx vitest run tasks/"],
  agt_sentinel: ["shell: npm run test:integration", "fs.read apps/harness/test/fixtures.ts", "shell: kill -9 <harness pid>", "report_progress 0.4 'resume asserted'"],
  agt_keel: ["kubectl get pods -n staging", "kubectl describe deploy/api -n staging"],
  agt_scout: ["browser.open docs.pgvector", "remember 'HNSW m=16 is enough'"],
};

export class MockBackend {
  private seq = 0;
  private harnesses = seedHarnesses();
  private agents = seedAgents();
  private threads = seedThreads(this.agents);
  private messages = seedMessages();
  private tasks = seedTasks();
  private dossiers = seedDossiers(this.agents);
  private guidance = seedGuidance();
  private board = seedBoard();
  private approvals: Approval[] = [
    {
      id: "apr_1", runId: "run_3", taskId: "tsk_deploy", agentId: "agt_keel", toolName: "shell", input: { command: "kubectl rollout restart deploy/api -n staging" },
      reason: "Pick up the rc1 image", risk: "high", status: "pending", stage: "operator", createdAt: ago(4 * MIN),
      reviewNotes: ["Overseer: unsure — restart interrupts Sentinel's running integration test", "Helper: unsure — staging is allowed, but should it wait ~30 min for the test?"],
    },
    { id: "apr_0", runId: "run_1", taskId: "tsk_lease", agentId: "agt_forge", toolName: "shell", input: { command: "npm run typecheck -w overseer" }, reason: "", risk: "medium", status: "approved", decidedBy: "overseer", note: "read-only check, in scope", createdAt: ago(30 * MIN) },
  ];
  private events: SystemEvent[] = [];
  private metrics: MetricsSnapshot[] = [];
  private settings = seedSettings();
  private windows: Record<ID, ThoughtWindow> = {};
  private teams = seedTeams();
  private builds: HarnessBuild[] = [];
  /** Enrollment tokens for demo builds (a real overseer stores only hashes). */
  private buildTokens: Record<ID, string> = {};
  private costToday = 14.2;

  constructor(private readonly emit: Emit) {
    // Backfill history so charts and feeds aren't empty on first load.
    for (let i = 90; i > 0; i--) this.metrics.push(this.sampleMetrics(ago(i * 2000)));
    for (let i = 40; i > 0; i--) this.events.push(this.randomEvent(ago(i * 20_000)));
  }

  start() {
    setInterval(() => this.tick(), 1500);
  }

  handle(msg: UiToOverseer) {
    switch (msg.type) {
      case "subscribe":
        // Cloned like a real network hop, so later in-place updates here can't leak into the store.
        this.emit(out("snapshot", structuredClone({
          harnesses: this.harnesses, agents: this.agents, threads: this.threads, messages: this.messages,
          tasks: this.tasks, dossiers: this.dossiers, approvals: this.approvals, events: this.events, metrics: this.metrics,
          settings: this.settings, thoughtWindows: Object.values(this.windows), teams: this.teams, builds: this.builds,
          boardThreads: this.board.threads, boardPosts: this.board.posts, guidance: this.guidance,
        })));
        return;
      case "unsubscribe":
        return;
      case "message.send":
        return this.onOperatorMessage(msg.payload.threadId, msg.payload.content, msg.payload.answersMessageId);
      case "thread.create": {
        const thread: Thread = { id: newId("thr"), kind: msg.payload.kind, title: msg.payload.title ?? "New conversation", createdAt: now(), updatedAt: now(), ...(msg.payload.teamId ? { teamId: msg.payload.teamId } : {}) };
        this.threads.push(thread);
        this.emit(out("entity", { kind: "thread", entity: thread }));
        return;
      }
      case "thought.insert":
        return this.onThought(msg.payload.agentId, msg.payload.content, msg.payload.answersMessageId);
      case "settings.update": {
        const p = msg.payload.patch;
        if (p.network?.allowPublic && !this.settings.operatorAuthConfigured) {
          this.pushEvent("error", { kind: "overseer", id: "overseer" }, "settings.rejected", "Public access refused: configure operator login first");
          this.pushSettings();
          return;
        }
        this.settings = {
          ...this.settings,
          network: { ...this.settings.network, ...p.network },
          credentials: { ...this.settings.credentials, ...p.credentials },
          chainOfCommand: { ...this.settings.chainOfCommand, ...p.chainOfCommand },
          workers: { ...this.settings.workers, ...p.workers },
          autonomy: { ...this.settings.autonomy, ...p.autonomy },
          approvals: { ...this.settings.approvals, ...p.approvals },
          updates: { ...this.settings.updates, ...p.updates },
          defaultProvider: p.defaultProvider ?? this.settings.defaultProvider,
          providers: this.settings.providers.map((pr) => ({ ...pr, ...p.providers?.find((x) => x.id === pr.id) })),
        };
        this.pushSettings();
        this.pushEvent("info", { kind: "operator", id: "op" }, "settings.updated", `Settings updated (${Object.keys(p).join(", ")})`);
        if (p.credentials || p.providers) this.pushEvent("info", { kind: "overseer", id: "overseer" }, "credentials.pushed", "Sent credentials.update to 2 harnesses");
        return;
      }
      case "provider.setKey": {
        const { provider, apiKey } = msg.payload;
        const key = apiKey.trim();
        this.settings = {
          ...this.settings,
          providers: this.settings.providers.map((pr) =>
            pr.id !== provider ? pr : key ? { ...pr, keySet: true, keyHint: `${key.match(/^[a-z]+-/i)?.[0] ?? ""}…${key.slice(-4)}`, keyUpdatedAt: now() } : { ...pr, keySet: false, keyHint: undefined, keyUpdatedAt: now() },
          ),
        };
        this.pushSettings();
        this.pushEvent(key ? "info" : "warn", { kind: "operator", id: "op" }, "provider.key", `${key ? "Set" : "Cleared"} API key for ${provider}`);
        this.pushEvent("info", { kind: "overseer", id: "overseer" }, "credentials.pushed", "Sent credentials.update to 2 harnesses");
        return;
      }
      case "team.create": {
        const team: Team = { ...msg.payload, id: newId("team"), createdAt: now() };
        this.teams.push(team);
        this.emit(out("entity", { kind: "team", entity: team }));
        this.pushEvent("info", { kind: "operator", id: "op" }, "team.created", `Team created: ${team.name}`);
        return;
      }
      case "team.update": {
        const team = this.teams.find((t) => t.id === msg.payload.teamId);
        if (!team) return;
        Object.assign(team, msg.payload.patch);
        this.emit(out("entity", { kind: "team", entity: { ...team } }));
        this.pushEvent("info", { kind: "operator", id: "op" }, "team.updated", `Team updated: ${team.name}`);
        return;
      }
      case "agent.move": {
        const team = this.teams.find((t) => t.id === msg.payload.teamId);
        if (!team) return;
        this.setAgent(msg.payload.agentId, { teamId: team.id });
        this.pushEvent("info", { kind: "operator", id: "op" }, "agent.moved", `${this.agentName(msg.payload.agentId)} moved to ${team.name}`, { agentId: msg.payload.agentId });
        return;
      }
      case "host.create":
        return this.onHostCreate(msg.payload);
      case "agent.spawn": {
        const p = msg.payload;
        const host = this.harnesses.find((h) => h.id === p.harnessId) ?? this.harnesses.filter((h) => h.status !== "offline").sort((a, b) => b.slots.total - a.slots.total)[0];
        if (!host) return this.pushEvent("error", { kind: "overseer", id: "overseer" }, "command.rejected", "Agent not spawned: no host is online");
        this.spawn(p.teamId, p.role, host, "operator", p.name);
        return;
      }
      case "agent.retire":
        return this.retire(msg.payload.agentId, "retired by the operator");
      case "agent.update": {
        const p = msg.payload;
        const a = this.agents.find((x) => x.id === p.agentId);
        if (!a) return;
        const tools = p.tools ?? a.toolGrants ?? [];
        this.setAgent(a.id, { toolGrants: tools, tools: tools.filter((t) => t.policy !== "deny").map((t) => t.name), ...(p.approvals ? { approvals: p.approvals } : {}) });
        this.pushEvent("info", { kind: "operator", id: "op" }, "agent.updated", `Permissions changed for ${a.name}`, { agentId: a.id });
        return;
      }
      case "board.post": {
        const p = msg.payload;
        this.boardPost("operator", "op", "Operator", p.content, p.threadId ? { threadId: p.threadId } : { board: p.board, subject: p.subject ?? "Untitled" });
        return;
      }
      case "guidance.add": {
        const g: HelperGuidance = { id: newId("gdn"), content: msg.payload.content, createdAt: now() };
        this.guidance.push(g);
        this.emit(out("entity", { kind: "guidance", entity: g }));
        return;
      }
      case "guidance.remove": {
        const g = this.guidance.find((x) => x.id === msg.payload.id);
        if (!g) return;
        this.guidance = this.guidance.filter((x) => x !== g);
        this.emit(out("entity", { kind: "guidance", entity: { ...g, removed: true } }));
        return;
      }
      case "data.reset": {
        // Back to the demo's starting state: a fresh backend's data, same emitter and ticker.
        Object.assign(this, new MockBackend(this.emit));
        this.handle(envelope("subscribe", { topics: [] }) as UiToOverseer);
        return;
      }
      case "harness.update": {
        const h = this.harnesses.find((x) => x.id === msg.payload.harnessId);
        if (!h) return;
        this.pushEvent("info", { kind: "overseer", id: "overseer" }, "harness.update_sent", `${h.name} is already up to date (demo)`);
        return;
      }
      case "build.revoke": {
        const b = this.builds.find((x) => x.id === msg.payload.buildId);
        if (!b || b.status !== "pending") return;
        b.status = "revoked";
        this.emit(out("entity", { kind: "build", entity: { ...b } }));
        this.pushEvent("warn", { kind: "operator", id: "op" }, "build.revoked", `Revoked build for ${b.harnessName}`);
        return;
      }
      case "provider.test": {
        const pr = this.settings.providers.find((x) => x.id === msg.payload.provider);
        setTimeout(() => {
          if (pr?.keySet) this.pushEvent("info", { kind: "overseer", id: "overseer" }, "provider.test", `${pr.label}: connection OK (${pr.models.length} models, 212 ms)`);
          else this.pushEvent("error", { kind: "overseer", id: "overseer" }, "provider.test", `${pr?.label ?? msg.payload.provider}: no API key set`);
        }, 600);
        return;
      }
      case "task.create": {
        const p = msg.payload;
        const task: Task = {
          id: newId("tsk"), title: p.title, description: p.description, status: "queued", priority: p.priority, teamId: p.teamId,
          threadId: this.threads.find((t) => t.kind === "operator_overseer" && t.teamId === p.teamId)?.id ?? "thr_costs",
          usedTokens: 0, usedUsd: 0, attempt: 1, checkpointCount: 0, createdAt: now(), updatedAt: now(),
          ...(p.agentId ? { agentId: p.agentId } : {}), ...(p.budgetTokens ? { budget: { tokens: p.budgetTokens } } : {}),
        };
        this.tasks.unshift(task);
        this.pushTask(task);
        this.pushEvent("info", { kind: "operator", id: "op" }, "task.created", `Task created: ${task.title}`, { taskId: task.id });
        return;
      }
      case "task.signal": {
        const task = this.tasks.find((t) => t.id === msg.payload.taskId);
        if (!task) return;
        const next: Record<string, TaskStatus> = { pause: "paused", resume: "running", cancel: "cancelled", retry: "queued" };
        const status = next[msg.payload.signal] as TaskStatus;
        Object.assign(task, { status, updatedAt: now() }, msg.payload.signal === "retry" ? { attempt: task.attempt + 1, progress: 0 } : {});
        if (status === "cancelled") task.finishedAt = now();
        this.pushTask(task);
        this.pushEvent(status === "cancelled" ? "warn" : "info", { kind: "operator", id: "op" }, "task.signal", `Operator ${msg.payload.signal}d “${task.title}”`, { taskId: task.id });
        return;
      }
      case "approval.decide": {
        const a = this.approvals.find((x) => x.id === msg.payload.approvalId);
        if (!a) return;
        a.status = msg.payload.approved ? "approved" : "denied";
        a.decidedBy = "operator";
        this.emit(out("entity", { kind: "approval", entity: a }));
        const task = this.tasks.find((t) => t.id === a.taskId);
        if (task) {
          Object.assign(task, { status: "running", updatedAt: now(), progressNote: msg.payload.approved ? "Restarting staging API" : "Approval denied — looking for alternative" });
          this.pushTask(task);
        }
        this.setAgent(a.agentId, { status: "busy", currentFocus: msg.payload.approved ? "Rolling out rc1 to staging" : "Re-planning deploy without restart" });
        this.pushEvent(msg.payload.approved ? "info" : "warn", { kind: "operator", id: "op" }, "approval.decided", `${msg.payload.approved ? "Approved" : "Denied"}: ${a.toolName} for ${this.agentName(a.agentId)}`, { agentId: a.agentId, taskId: a.taskId });
        return;
      }
    }
  }

  // --- simulation -----------------------------------------------------------

  private tick() {
    // Heartbeats
    for (const h of this.harnesses) {
      if (h.status === "offline") continue;
      h.lastHeartbeatAt = now();
      h.load = { cpu: Math.max(0.05, Math.min(0.95, (h.load?.cpu ?? 0.3) + (Math.random() - 0.5) * 0.1)), memMb: h.load?.memMb ?? 4000 };
      this.emit(out("entity", { kind: "harness", entity: { ...h } }));
    }

    // Progress on running tasks
    for (const task of this.tasks.filter((t) => t.status === "running")) {
      if (Math.random() < 0.5) continue;
      const tokens = Math.round(2000 + Math.random() * 9000);
      task.usedTokens += tokens;
      task.usedUsd += tokens * 0.000008;
      task.progress = Math.min(1, (task.progress ?? 0) + Math.random() * 0.02);
      task.checkpointCount += 1;
      task.updatedAt = now();
      if (task.progress >= 1) {
        Object.assign(task, { status: "succeeded", finishedAt: now(), progressNote: "Done" });
        if (task.agentId) this.setAgent(task.agentId, { status: "idle", activeRunIds: [], currentFocus: `Idle — finished “${task.title}”` });
        this.pushEvent("info", { kind: "agent", id: task.agentId ?? "?" }, "task.succeeded", `${this.agentName(task.agentId)} finished “${task.title}”`, { taskId: task.id, agentId: task.agentId });
      }
      this.pushTask(task);
    }

    // Assign queued work to idle, online agents
    const queued = this.tasks.find((t) => t.status === "queued");
    const idle = queued && this.agents.find((a) => a.status === "idle" && a.teamId === queued.teamId);
    if (queued && idle && Math.random() < 0.15) {
      Object.assign(queued, { status: "running", agentId: idle.id, startedAt: now(), updatedAt: now(), progress: 0.01, progressNote: "Reading briefing" });
      this.setAgent(idle.id, { status: "busy", activeRunIds: [newId("run")], currentFocus: queued.title });
      this.pushTask(queued);
      this.pushEvent("info", { kind: "overseer", id: "overseer" }, "run.assigned", `Assigned “${queued.title}” to ${idle.name}`, { taskId: queued.id, agentId: idle.id });
    }

    // Board chatter
    const talker = this.agents.filter((a) => a.status === "busy" || a.status === "waiting");
    const work = this.board.threads.find((t) => t.board === "work");
    if (work && talker.length && Math.random() < 0.04) {
      const a = pick(talker);
      this.boardPost("agent", a.id, a.name, pick([
        `Progress: ${a.currentFocus ?? "working"}.`,
        `>>${work.no} on track, nothing blocking me.`,
        "Checkpoint written; context compacted to stay inside the window, carrying on.",
      ]), { threadId: work.id });
    }

    // Activity noise
    const e = this.randomEvent(now());
    this.events.push(e);
    this.emit(out("event", e));

    // Metrics
    this.costToday += Math.random() * 0.05;
    const m = this.sampleMetrics(now());
    this.metrics.push(m);
    this.emit(out("metrics", m));
  }

  private sampleMetrics(ts: string): MetricsSnapshot {
    const live = this.agents.filter((a) => a.status !== "retired");
    const online = live.filter((a) => a.status !== "offline").length;
    const prev = this.metrics.at(-1);
    const tpm = Math.max(8000, Math.round((prev?.tokensPerMin ?? 42_000) + (Math.random() - 0.5) * 9000));
    return {
      ts, agentsOnline: online, agentsTotal: live.length,
      runsActive: this.tasks.filter((t) => t.status === "running" || t.status === "waiting_approval").length,
      tasksQueued: this.tasks.filter((t) => t.status === "queued").length,
      tokensPerMin: tpm, costTodayUsd: this.costToday,
      errorRate: Math.max(0, Math.min(0.2, (prev?.errorRate ?? 0.02) + (Math.random() - 0.5) * 0.01)),
      p50LatencyMs: Math.round(900 + Math.random() * 600),
    };
  }

  private randomEvent(ts: string): SystemEvent {
    const busy = this.agents.filter((a) => a.status === "busy" || a.status === "waiting");
    const roll = Math.random();
    const agent = busy.length ? pick(busy) : undefined;
    let level: EventLevel = "info";
    let type = "run.tool.call";
    let summary: string;
    let source: SystemEvent["source"] = { kind: "agent", id: agent?.id ?? "overseer" };
    if (!agent || roll < 0.12) {
      source = { kind: "overseer", id: "overseer" };
      type = pick(["context.digest", "supervisor.tick", "memory.added"]);
      summary = pick(["Updated dossier for Forge (v14)", "Supervisor tick: 3 runs healthy, 0 stuck", "Stored memory: “reaper interval 15s”"]);
    } else if (roll < 0.2) {
      level = "warn";
      type = "run.tool.result";
      summary = `${agent.name}: tool exited non-zero (retrying)`;
    } else if (roll < 0.23) {
      level = "error";
      type = "gateway.error";
      summary = `${agent.name}: model call failed with 529 overloaded — retry 1/2`;
    } else if (roll < 0.35) {
      type = "run.checkpoint";
      summary = `${agent.name}: checkpoint written (turn ${Math.floor(Math.random() * 60) + 5})`;
    } else if (roll < 0.42) {
      type = "context.request";
      summary = `${agent.name} asked the overseer: “Where is the queue connection configured?”`;
    } else {
      summary = `${agent.name}: ${pick(TOOL_LINES[agent.id] ?? ["thinking…"])}`;
    }
    return { seq: ++this.seq, id: newId("evt"), ts, level, source, type, summary, ...(agent ? { agentId: agent.id } : {}) };
  }

  private onOperatorMessage(threadId: ID, content: string, answersMessageId?: ID) {
    const thread = this.threads.find((t) => t.id === threadId);
    if (!thread || thread.kind === "overseer_agent") return; // operators talk to the overseer and its helper
    const op: Message = { id: newId("msg"), threadId, role: "operator", authorId: "op", content, createdAt: now() };
    this.messages.push(op);
    this.emit(out("message", op));
    this.pushEvent("info", { kind: "operator", id: "op" }, "message.sent", `Operator → Overseer: ${content.slice(0, 60)}`, { threadId });

    let reply: string;
    const escalation = answersMessageId ? this.messages.find((m) => m.id === answersMessageId) : undefined;
    if (thread.kind === "operator_helper") {
      if (escalation) {
        escalation.resolved = true;
        this.emit(out("message", { ...escalation }));
      }
      const g: HelperGuidance = { id: newId("gdn"), content, createdAt: now() };
      if (!escalation) {
        this.guidance.push(g);
        this.emit(out("entity", { kind: "guidance", entity: g }));
      }
      setTimeout(() => this.pushMessage(threadId, "helper", "helper", escalation ? "Thanks, passing that on to the Overseer. I've stored it so we don't ask again." : `Saved as guidance: “${content.slice(0, 80)}”. I'll answer the Overseer that way while you're away.`), 900);
      return;
    } else if (escalation) {
      escalation.resolved = true;
      this.emit(out("message", { ...escalation }));
      reply = "Thanks — decision recorded in memory so I won't ask again. I've passed it on to Keel and Sentinel.";
      this.pushMessage(`thr_agent_agt_keel`, "overseer", "overseer", `Operator decided: “${content.slice(0, 80)}”. Proceed accordingly.`);
    } else {
      reply = pick([
        "On it. I'll check the fleet and come back with a plan. Forge and Sentinel are busy; Scout is free, so I'll start there.",
        "Here's where things stand:\n• Lease reaper — 62% (Forge)\n• Kill-harness test — 35% (Sentinel)\n• Staging deploy — parked until you answer my question above (Keel)\n\nWant me to reprioritise anything?",
        "I've created a task for that and briefed Scout with the relevant memories. I'll post the result here when it lands.",
      ]);
    }
    const msg: Message = { id: newId("msg"), threadId, role: "overseer", authorId: "overseer", content: "", createdAt: now(), partial: true };
    // Stream the reply word by word, like a real model response.
    const words = reply.split(/(\s+)/);
    let i = 0;
    setTimeout(() => {
      const timer = setInterval(() => {
        i += 3;
        const done = i >= words.length;
        const update: Message = { ...msg, content: words.slice(0, i).join(""), ...(done ? { partial: false } : {}) };
        if (done) {
          clearInterval(timer);
          this.messages.push(update);
        }
        this.emit(out("message", update));
      }, 70);
    }, 700);
  }

  /**
   * Operator thought (DESIGN §5b.3): opens/extends the agent's thought window. Inside the
   * window the agent may reply or ask; unanswered questions are answered by the overseer.
   */
  private onThought(agentId: ID, content: string, answersMessageId?: ID) {
    const agent = this.agents.find((a) => a.id === agentId);
    const thread = this.threads.find((t) => t.kind === "overseer_agent" && t.agentId === agentId);
    if (!agent || !thread) return;
    this.pushMessage(thread.id, "operator", "op", content, "thought");
    this.openWindow(agentId);

    const question = answersMessageId ? this.messages.find((m) => m.id === answersMessageId && !m.resolved) : undefined;
    if (question) {
      Object.assign(question, { resolved: true, answeredBy: "operator" });
      this.emit(out("message", { ...question }));
      this.pushEvent("info", { kind: "operator", id: "op" }, "question.answered", `Operator answered ${agent.name}'s question`, { agentId });
      setTimeout(() => this.pushMessage(thread.id, "agent", agentId, "Thanks — proceeding with that.", "reply"), 1200);
      return;
    }

    const live = agent.activeRunIds.length > 0;
    this.pushEvent("info", { kind: "operator", id: "op" }, "thought.inserted", `Thought inserted into ${agent.name}${live ? "" : " (queued for next run)"}`, { agentId });
    if (!live) return;
    setTimeout(() => {
      this.pushEvent("info", { kind: "agent", id: agentId }, "run.inject", `${agent.name}: operator thought applied at turn boundary`, { agentId });
      if (Math.random() < 0.5) {
        this.pushMessage(thread.id, "agent", agentId, pick([
          "Got it — applied. Adjusting my current step; no change to the estimate.",
          "Understood. That conflicts with my briefing on one point, so I'm following your thought and letting the Overseer know.",
        ]), "reply");
      } else {
        this.askOperator(agent, thread.id, pick([
          "Before I switch: should the old behaviour stay behind a flag, or can I remove it entirely?",
          "That adds ~30 min to the run. OK to go over the current estimate, or should I drop the extra tests?",
        ]));
      }
    }, 1800);
  }

  private openWindow(agentId: ID) {
    const until = new Date(Date.now() + this.settings.chainOfCommand.thoughtWindowMinutes * MIN).toISOString();
    const w: ThoughtWindow = { agentId, openedAt: this.windows[agentId]?.openedAt ?? now(), openUntil: until };
    this.windows[agentId] = w;
    this.emit(out("entity", { kind: "thoughtWindow", entity: w }));
  }

  /** Agent question to the operator; only valid inside an open window. */
  private askOperator(agent: Agent, threadId: ID, content: string) {
    const w = this.windows[agent.id];
    if (!w || new Date(w.openUntil).getTime() < Date.now()) {
      this.pushEvent("warn", { kind: "overseer", id: "overseer" }, "operator.rejected", `${agent.name} tried to reach the operator outside a thought window — redirected to Overseer`, { agentId: agent.id });
      return;
    }
    const timeoutMs = this.settings.chainOfCommand.operatorAnswerTimeoutMinutes * MIN;
    const q: Message = {
      id: newId("msg"), threadId, role: "agent", authorId: agent.id, content, createdAt: now(),
      kind: "question", resolved: false, answerDeadline: new Date(Date.now() + timeoutMs).toISOString(),
    };
    this.messages.push(q);
    this.emit(out("message", q));
    this.pushEvent("info", { kind: "agent", id: agent.id }, "question.asked", `${agent.name} asked you a question (Overseer answers in ${this.settings.chainOfCommand.operatorAnswerTimeoutMinutes} min)`, { agentId: agent.id });
    setTimeout(() => {
      if (q.resolved) return;
      Object.assign(q, { resolved: true, answeredBy: "overseer" });
      this.emit(out("message", { ...q }));
      this.pushMessage(threadId, "overseer", "overseer", "The operator didn't answer in time, so I'm deciding: keep the old behaviour behind a flag and stay within the current estimate. The operator can override this with a new thought.");
      this.pushEvent("info", { kind: "overseer", id: "overseer" }, "question.overseer_answered", `Overseer answered ${agent.name}'s question (operator timeout)`, { agentId: agent.id });
    }, timeoutMs);
  }

  /** A host build to download (generated in the browser in demo mode). */
  private onHostCreate(p: Extract<UiToOverseer, { type: "host.create" }>["payload"]) {
    const token = `enr_${newId().replace(/[^a-z0-9]/gi, "")}${newId().replace(/[^a-z0-9]/gi, "")}`.slice(0, 36);
    const buildId = newId("bld");
    let command: string;
    try {
      command = installCommand({ id: buildId, os: p.os }, p.overseerUrl.replace(/\/$/, ""), token);
    } catch (e) {
      this.pushEvent("error", { kind: "overseer", id: "overseer" }, "build.failed", `Host build not created: ${(e as Error).message}`);
      return;
    }
    const base = p.overseerUrl.replace(/\/$/, "");
    const build: HarnessBuild = {
      id: buildId, os: p.os, harnessName: p.harnessName, overseerUrl: base,
      status: "pending", createdAt: now(), expiresAt: new Date(Date.now() + 24 * 60 * MIN).toISOString(),
      downloadUrl: `${base}/api/builds/${buildId}/download?t=${token}`, installCommand: command,
    };
    this.builds.unshift(build);
    this.buildTokens[buildId] = token;
    this.emit(out("entity", { kind: "build", entity: build }));
    this.pushEvent("info", { kind: "operator", id: "op" }, "build.created", `${p.os === "windows" ? "Windows" : "Linux"} host build for ${p.harnessName}, waiting for it to connect`);
  }

  private spawn(teamId: ID, role: string, host: Harness, origin: "overseer" | "operator", name?: string) {
    const taken = new Set(this.agents.filter((a) => a.status !== "retired").map((a) => a.name.toLowerCase()));
    const pickName = name?.trim() && !taken.has(name.trim().toLowerCase()) ? name.trim() : ["Vega", "Lumen", "Rook", "Moss", "Flint", "Juno", "Wren", "Echo"].find((n) => !taken.has(n.toLowerCase())) ?? `Worker-${this.agents.length}`;
    const agent: Agent = {
      id: newId("agt"), teamId, harnessId: host.id, name: pickName, role, provider: "deepseek", model: "deepseek-flash", effort: this.settings.workers.effort,
      status: "idle", tools: this.settings.workers.defaultTools.filter((t) => t.policy !== "deny").map((t) => t.name), maxConcurrentRuns: 1, activeRunIds: [],
      currentFocus: "Idle — just spawned", origin, createdAt: now(),
    };
    this.agents.push(agent);
    const thread: Thread = { id: `thr_agent_${agent.id}`, kind: "overseer_agent", title: `Overseer ↔ ${agent.name}`, agentId: agent.id, createdAt: now(), updatedAt: now() };
    this.threads.push(thread);
    this.dossiers.push({ agentId: agent.id, version: 1, summary: `${agent.name}: ${role}`, currentFocus: "", recentResults: [], knownFacts: [], openQuestions: [], updatedAt: now() });
    this.emit(out("entity", { kind: "agent", entity: { ...agent } }));
    this.emit(out("entity", { kind: "thread", entity: thread }));
    this.emit(out("entity", { kind: "dossier", entity: this.dossiers.at(-1)! }));
    this.pushEvent("info", { kind: origin === "operator" ? "operator" : "overseer", id: origin === "operator" ? "op" : "overseer" }, "agent.spawned", `Spawned ${agent.name} (${role}) on ${host.name}`, { agentId: agent.id });
    return agent;
  }

  private retire(agentId: ID, reason: string) {
    const a = this.agents.find((x) => x.id === agentId);
    if (!a || a.status === "retired") return;
    for (const t of this.tasks.filter((x) => x.agentId === agentId && ["running", "assigned", "waiting_approval", "paused"].includes(x.status))) {
      Object.assign(t, { status: "queued", agentId: undefined, progressNote: `Requeued: ${a.name} was retired`, updatedAt: now() });
      this.pushTask(t);
    }
    this.setAgent(agentId, { status: "retired", activeRunIds: [], retiredAt: now(), retireReason: reason, currentFocus: `Retired: ${reason}` });
    this.pushEvent("info", { kind: "overseer", id: "overseer" }, "agent.retired", `Retired ${a.name}: ${reason}`, { agentId });
  }

  private boardPost(authorKind: BoardPost["authorKind"], authorId: ID, authorName: string, content: string, where: { threadId: ID } | { board: BoardThread["board"]; subject: string }) {
    const no = Math.max(100, ...this.board.posts.map((p) => p.no)) + 1;
    let thread: BoardThread | undefined;
    if ("threadId" in where) {
      thread = this.board.threads.find((t) => t.id === where.threadId);
      if (!thread) return;
      Object.assign(thread, { bumpedAt: now(), replyCount: thread.replyCount + 1 });
    } else {
      thread = { id: newId("bth"), board: where.board, no, subject: where.subject, authorKind, authorId, authorName, createdAt: now(), bumpedAt: now(), replyCount: 0 };
      this.board.threads.push(thread);
    }
    const post: BoardPost = { id: newId("bpo"), no, threadId: thread.id, board: thread.board, authorKind, authorId, authorName, content, createdAt: now() };
    this.board.posts.push(post);
    this.emit(out("entity", { kind: "boardThread", entity: { ...thread } }));
    this.emit(out("board.post", post));
  }

  /** Zip for a demo build, generated in the browser with the same generator the overseer uses. */
  buildZip(buildId: ID): { filename: string; data: Uint8Array } | undefined {
    const b = this.builds.find((x) => x.id === buildId);
    const token = this.buildTokens[buildId];
    if (!b || !token) return undefined;
    const files = generateBuildFiles({ build: b, enrollmentToken: token }, HARNESS_SOURCES);
    return { filename: `${files[0]!.path.split("/")[0]}-${b.os}.zip`, data: zipBuild(files) };
  }

  // --- helpers ----------------------------------------------------------------

  private pushMessage(threadId: ID, role: Message["role"], authorId: ID, content: string, kind?: Message["kind"]) {
    const m: Message = { id: newId("msg"), threadId, role, authorId, content, createdAt: now(), ...(kind ? { kind } : {}) };
    this.messages.push(m);
    this.emit(out("message", m));
  }

  private pushSettings() {
    this.emit(out("entity", { kind: "settings", entity: this.settings }));
  }

  private agentName(id?: ID) {
    return this.agents.find((a) => a.id === id)?.name ?? "Unassigned";
  }

  private setAgent(id: ID, patch: Partial<Agent>) {
    const a = this.agents.find((x) => x.id === id);
    if (!a) return;
    Object.assign(a, patch);
    this.emit(out("entity", { kind: "agent", entity: { ...a } }));
  }

  private pushTask(task: Task) {
    this.emit(out("entity", { kind: "task", entity: { ...task } }));
  }

  private pushEvent(level: EventLevel, source: SystemEvent["source"], type: string, summary: string, rel: Partial<SystemEvent> = {}) {
    const e: SystemEvent = { seq: ++this.seq, id: newId("evt"), ts: now(), level, source, type, summary, ...rel };
    this.events.push(e);
    this.emit(out("event", e));
  }
}
