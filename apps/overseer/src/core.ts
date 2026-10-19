// The overseer's state. Everything lives in memory (small fleets) and is written through
// to SQLite. Every change is broadcast to consoles as an entity / message / event.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join, relative } from "node:path";
import type {
  Agent,
  AgentDefinition,
  Approval,
  BoardPost,
  BoardThread,
  Dossier,
  EntityUpdate,
  EventLevel,
  Harness,
  HarnessBuild,
  HelperGuidance,
  ID,
  Message,
  MetricsSnapshot,
  OverseerToUi,
  ProviderId,
  Run,
  ServerSettings,
  Snapshot,
  SystemEvent,
  Task,
  Team,
  ThoughtWindow,
  Thread,
} from "@alliance/protocol";
import { harnessSourceFiles, zipUpdatePackage } from "@alliance/harness-kit";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { Secrets } from "./secrets.js";
import { newId, nowIso } from "./ids.js";
import { PROVIDERS, defaultProviderSettings, keyHint } from "./providers/registry.js";
import { envelope } from "./envelope.js";

export interface Memory {
  id: ID;
  kind: "fact" | "decision" | "reference" | "preference";
  content: string;
  /** "global" or "team:<id>" */
  scope: string;
  source: { agentId?: ID; taskId?: ID; runId?: ID; operator?: boolean };
  createdAt: string;
}

export interface UsageRecord {
  ts: number;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  durationMs: number;
  agentId?: ID;
  runId?: ID;
  taskId?: ID;
  source: "gateway" | "overseer" | "harness";
}

/** Settings as stored (computed fields are added in publicSettings()). */
type StoredSettings = Omit<ServerSettings, "locked" | "operatorAuthConfigured" | "providers" | "network"> & {
  network: Omit<ServerSettings["network"], "advertisedUrls">;
  providers: Omit<ServerSettings["providers"][number], "keySet" | "keyHint" | "keyUpdatedAt">[];
};

export interface ActiveRun extends Run {
  harnessId: ID;
}

const ENTITY_COLLECTION: Record<Exclude<EntityUpdate["kind"], "settings">, string> = {
  harness: "harnesses",
  agent: "agents",
  thread: "threads",
  task: "tasks",
  run: "runs",
  dossier: "dossiers",
  approval: "approvals",
  thoughtWindow: "thought_windows",
  team: "teams",
  build: "builds",
  boardThread: "board_threads",
  guidance: "guidance",
};

const MAX_EVENTS = 1000;

export class Core {
  readonly teams = new Map<ID, Team>();
  readonly agents = new Map<ID, Agent>();
  readonly agentDefs = new Map<ID, AgentDefinition>();
  readonly harnesses = new Map<ID, Harness>();
  readonly threads = new Map<ID, Thread>();
  readonly messages = new Map<ID, Message[]>();
  readonly tasks = new Map<ID, Task>();
  readonly runs = new Map<ID, ActiveRun>();
  readonly dossiers = new Map<ID, Dossier>();
  readonly approvals = new Map<ID, Approval>();
  readonly builds = new Map<ID, HarnessBuild>();
  readonly windows = new Map<ID, ThoughtWindow>();
  readonly boardThreads = new Map<ID, BoardThread>();
  readonly guidance = new Map<ID, HelperGuidance>();
  /** All board posts, oldest first. Post numbers are global (DESIGN §5e). */
  boardPosts: BoardPost[] = [];
  boardSeq = 0;
  memories: Memory[] = [];
  events: SystemEvent[] = [];
  metrics: MetricsSnapshot[] = [];
  usage: UsageRecord[] = [];
  settings: StoredSettings;
  private seq: number;
  /** Set by the console hub. */
  broadcast: (msg: OverseerToUi) => void = () => {};
  private sourceCache?: { at: number; hash: string; files: Record<string, string>; zip: Uint8Array; sha256: string };

  constructor(
    readonly cfg: Config,
    readonly db: Db,
    readonly secrets: Secrets,
  ) {
    const load = <T>(collection: string, map: Map<ID, T>, key: (t: T) => ID) => {
      for (const doc of db.all<T>(collection)) map.set(key(doc), doc);
    };
    load("teams", this.teams, (t) => t.id);
    load("agents", this.agents, (a) => a.id);
    load("agent_defs", this.agentDefs, (a) => a.id);
    load("harnesses", this.harnesses, (h) => h.id);
    load("threads", this.threads, (t) => t.id);
    load("tasks", this.tasks, (t) => t.id);
    load("runs", this.runs, (r) => r.id);
    load("dossiers", this.dossiers, (d) => d.agentId);
    load("approvals", this.approvals, (a) => a.id);
    load("builds", this.builds, (b) => b.id);
    load("thought_windows", this.windows, (w) => w.agentId);
    load("board_threads", this.boardThreads, (t) => t.id);
    load("guidance", this.guidance, (g) => g.id);
    this.boardPosts = db.all<BoardPost>("board_posts").sort((a, b) => a.no - b.no);
    this.boardSeq = this.boardPosts.at(-1)?.no ?? 0;
    this.memories = db.all<Memory>("memories");
    for (const m of db.all<Message>("messages").sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const list = this.messages.get(m.threadId) ?? [];
      list.push(m);
      this.messages.set(m.threadId, list);
    }
    this.events = db.recentEvents(MAX_EVENTS);
    this.seq = db.maxEventSeq();
    this.settings = this.loadSettings();
    this.recoverAfterRestart();
    this.seedIfEmpty();
    this.helperThread();
    // Agents from before per-agent permissions: expose their grants to the console.
    for (const a of this.agents.values()) {
      const d = this.agentDefs.get(a.id);
      if (d && !a.toolGrants) this.agents.set(a.id, { ...a, toolGrants: d.tools, ...(d.approvals ? { approvals: d.approvals } : {}) });
    }
  }

  // -- settings -----------------------------------------------------------------

  private loadSettings(): StoredSettings {
    const defaults: StoredSettings = {
      network: { allowPublic: false, bindHost: this.cfg.bindHost, port: this.cfg.port, extraAllowedCidrs: [], trustProxy: false },
      credentials: { delivery: "gateway" },
      updates: { mode: "automatic" },
      chainOfCommand: { thoughtWindowMinutes: 15, operatorAnswerTimeoutMinutes: 5 },
      workers: {
        maxAgents: 12,
        idleRetireMinutes: 30,
        effort: "high",
        defaultTools: [
          { name: "shell", policy: "ask" },
          { name: "read_file", policy: "allow" },
          { name: "write_file", policy: "ask" },
          { name: "list_dir", policy: "allow" },
        ],
      },
      autonomy: { followUps: true, maxFollowUpsPerHour: 20 },
      approvals: { low: "approve", medium: "overseer", high: "overseer" },
      defaultProvider: "deepseek",
      providers: defaultProviderSettings().map(({ keySet: _k, keyHint: _h, keyUpdatedAt: _u, ...p }) => p),
    };
    const stored = this.db.get<Partial<StoredSettings>>("settings", "server");
    const merged: StoredSettings = {
      ...defaults,
      ...stored,
      network: { ...defaults.network, ...stored?.network, bindHost: this.cfg.bindHost, port: this.cfg.port },
      credentials: { ...defaults.credentials, ...stored?.credentials },
      updates: { ...defaults.updates, ...stored?.updates },
      chainOfCommand: { ...defaults.chainOfCommand, ...stored?.chainOfCommand },
      workers: { ...defaults.workers, ...stored?.workers },
      autonomy: { ...defaults.autonomy, ...stored?.autonomy },
      approvals: { ...defaults.approvals, ...stored?.approvals },
      // Keep provider availability/model lists from the registry; keep the operator's choices.
      providers: defaults.providers.map((d) => {
        const s = stored?.providers?.find((p) => p.id === d.id);
        return s ? { ...d, enabled: s.enabled, baseUrl: s.baseUrl || d.baseUrl, defaultModel: s.defaultModel || d.defaultModel } : d;
      }),
    };
    if (this.cfg.allowPublic !== undefined) merged.network.allowPublic = this.cfg.allowPublic;
    return merged;
  }

  saveSettings(): void {
    this.db.put("settings", "server", this.settings);
    this.broadcast(envelope("entity", { kind: "settings", entity: this.publicSettings() } as EntityUpdate));
  }

  lockedSettings(): string[] {
    const locked = ["network.bindHost", "network.port"];
    if (this.cfg.allowPublic !== undefined) locked.push("network.allowPublic");
    if (this.cfg.deepseekApiKey) locked.push("providers.deepseek.key");
    return locked;
  }

  publicSettings(): ServerSettings {
    return {
      ...this.settings,
      network: { ...this.settings.network, advertisedUrls: this.advertisedUrls() },
      providers: this.settings.providers.map((p) => {
        const key = this.providerKey(p.id);
        const stored = this.db.get<{ updatedAt: string }>("provider_keys", p.id);
        return { ...p, keySet: !!key, ...(key ? { keyHint: keyHint(key) } : {}), ...(stored ? { keyUpdatedAt: stored.updatedAt } : {}) };
      }),
      locked: this.lockedSettings(),
      // Operator login isn't built yet, so public access stays off (DESIGN §10.1).
      operatorAuthConfigured: false,
    };
  }

  /** LAN addresses harnesses can use, e.g. http://192.168.1.20:8080. */
  advertisedUrls(): string[] {
    const urls: string[] = [];
    for (const addrs of Object.values(networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (a.family === "IPv4" && !a.internal) urls.push(`http://${a.address}:${this.cfg.port}`);
      }
    }
    urls.push(`http://127.0.0.1:${this.cfg.port}`);
    return urls;
  }

  providerKey(id: ProviderId): string | undefined {
    if (id === "deepseek" && this.cfg.deepseekApiKey) return this.cfg.deepseekApiKey;
    const stored = this.db.get<{ enc: string }>("provider_keys", id);
    if (!stored) return undefined;
    try {
      return this.secrets.decrypt(stored.enc);
    } catch {
      return undefined;
    }
  }

  setProviderKey(id: ProviderId, key: string): void {
    if (key) this.db.put("provider_keys", id, { enc: this.secrets.encrypt(key), updatedAt: nowIso() });
    else this.db.delete("provider_keys", id);
    this.saveSettings();
  }

  providerSettings(id: ProviderId) {
    return this.settings.providers.find((p) => p.id === id);
  }

  // -- mutations (persist + broadcast) -------------------------------------------

  upsert<K extends Exclude<EntityUpdate["kind"], "settings">>(kind: K, entity: Extract<EntityUpdate, { kind: K }>["entity"]): void {
    const id = kind === "dossier" || kind === "thoughtWindow" ? (entity as Dossier).agentId : (entity as { id: ID }).id;
    const map = {
      harness: this.harnesses, agent: this.agents, thread: this.threads, task: this.tasks, run: this.runs,
      dossier: this.dossiers, approval: this.approvals, thoughtWindow: this.windows, team: this.teams, build: this.builds,
      boardThread: this.boardThreads, guidance: this.guidance,
    }[kind] as Map<ID, unknown>;
    map.set(id, entity);
    this.db.put(ENTITY_COLLECTION[kind], id, entity);
    this.broadcast(envelope("entity", { kind, entity } as EntityUpdate));
  }

  saveAgentDef(def: AgentDefinition): void {
    this.agentDefs.set(def.id, def);
    this.db.put("agent_defs", def.id, def);
  }

  /** Add or replace a message (replace = same id, e.g. a streamed reply). */
  putMessage(m: Message): Message {
    const list = this.messages.get(m.threadId) ?? [];
    const i = list.findIndex((x) => x.id === m.id);
    if (i === -1) list.push(m);
    else list[i] = m;
    this.messages.set(m.threadId, list);
    if (!m.partial) this.db.put("messages", m.id, m);
    const thread = this.threads.get(m.threadId);
    if (thread && i === -1) {
      thread.updatedAt = m.createdAt;
      this.db.put("threads", thread.id, thread);
    }
    this.broadcast(envelope("message", m));
    return m;
  }

  post(threadId: ID, role: Message["role"], authorId: ID, content: string, extra: Partial<Message> = {}): Message {
    return this.putMessage({ id: newId("msg"), threadId, role, authorId, content, createdAt: nowIso(), ...extra });
  }

  findMessage(id: ID): Message | undefined {
    for (const list of this.messages.values()) {
      const m = list.find((x) => x.id === id);
      if (m) return m;
    }
    return undefined;
  }

  event(level: EventLevel, source: SystemEvent["source"], type: string, summary: string, rel: Partial<Pick<SystemEvent, "agentId" | "taskId" | "runId" | "threadId" | "data">> = {}): void {
    const e: SystemEvent = { seq: ++this.seq, id: newId("evt"), ts: nowIso(), level, source, type, summary, ...rel };
    this.events.push(e);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.db.appendEvent(e);
    this.broadcast(envelope("event", e));
  }

  addMemory(m: Omit<Memory, "id" | "createdAt">): Memory {
    const mem: Memory = { ...m, id: newId("mem"), createdAt: nowIso() };
    this.memories.push(mem);
    this.db.put("memories", mem.id, mem);
    return mem;
  }

  /** Simple keyword search over memories visible to a team (global + team scope). */
  searchMemory(query: string, teamId: ID | undefined, topK = 5): Memory[] {
    const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    return this.memories
      .filter((m) => m.scope === "global" || (teamId && m.scope === `team:${teamId}`))
      .map((m) => ({ m, score: words.reduce((n, w) => n + (m.content.toLowerCase().includes(w) ? 1 : 0), 0) }))
      .filter((x) => x.score > 0 || words.length === 0)
      .sort((a, b) => b.score - a.score || b.m.createdAt.localeCompare(a.m.createdAt))
      .slice(0, topK)
      .map((x) => x.m);
  }

  recordUsage(u: UsageRecord): void {
    this.usage.push(u);
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    while (this.usage.length && this.usage[0]!.ts < cutoff) this.usage.shift();
    if (u.taskId) {
      const t = this.tasks.get(u.taskId);
      if (t) {
        t.usedTokens += u.inputTokens + u.outputTokens;
        t.updatedAt = nowIso();
        this.upsert("task", t);
      }
    }
  }

  // -- lookups --------------------------------------------------------------------

  /** The operator ↔ overseer thread for a team (created if missing). */
  teamThread(teamId: ID | undefined): Thread {
    const existing = [...this.threads.values()].find((t) => t.kind === "operator_overseer" && t.teamId === teamId);
    if (existing) return existing;
    const team = teamId ? this.teams.get(teamId) : undefined;
    const thread: Thread = { id: newId("thr"), kind: "operator_overseer", title: team ? `${team.name}: general` : "General", createdAt: nowIso(), updatedAt: nowIso(), ...(teamId ? { teamId } : {}) };
    this.upsert("thread", thread);
    return thread;
  }

  /** The operator ↔ helper conversation (DESIGN §5d); there is one. */
  helperThread(): Thread {
    const existing = [...this.threads.values()].find((t) => t.kind === "operator_helper");
    if (existing) return existing;
    const thread: Thread = { id: newId("thr"), kind: "operator_helper", title: "Helper", createdAt: nowIso(), updatedAt: nowIso() };
    this.upsert("thread", thread);
    return thread;
  }

  /** The operator's standing instructions to the helper (and the Overseer). */
  activeGuidance(): string[] {
    return [...this.guidance.values()].filter((g) => !g.removed).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((g) => g.content);
  }

  /** Agents that exist on a host (not retired). */
  liveAgents(): Agent[] {
    return [...this.agents.values()].filter((a) => a.status !== "retired");
  }

  /** Find an agent by name or id, preferring live agents (names of retired ones may be reused). */
  findAgent(nameOrId: string, teamId?: ID): Agent | undefined {
    const n = nameOrId.trim().replace(/^@/, "").toLowerCase();
    const match = (a: Agent) => (!teamId || a.teamId === teamId) && (a.name.toLowerCase() === n || a.id === nameOrId);
    return this.liveAgents().find(match) ?? [...this.agents.values()].find(match);
  }

  agentThread(agentId: ID): Thread {
    const existing = [...this.threads.values()].find((t) => t.kind === "overseer_agent" && t.agentId === agentId);
    if (existing) return existing;
    const agent = this.agents.get(agentId);
    const thread: Thread = { id: newId("thr"), kind: "overseer_agent", title: `Overseer ↔ ${agent?.name ?? agentId}`, agentId, createdAt: nowIso(), updatedAt: nowIso() };
    this.upsert("thread", thread);
    return thread;
  }

  agentRuns(agentId: ID): ActiveRun[] {
    return [...this.runs.values()].filter((r) => r.agentId === agentId && (r.status === "assigned" || r.status === "running" || r.status === "waiting_approval" || r.status === "paused"));
  }

  harnessRuns(harnessId: ID): ActiveRun[] {
    return [...this.runs.values()].filter((r) => r.harnessId === harnessId && !["succeeded", "failed", "cancelled"].includes(r.status));
  }

  openWindow(agentId: ID): ThoughtWindow | undefined {
    const w = this.windows.get(agentId);
    return w && new Date(w.openUntil).getTime() > Date.now() ? w : undefined;
  }

  /** Recompute an agent's status from its harness connection, runs and pending questions. */
  refreshAgent(agentId: ID, online: (harnessId: ID) => boolean, patch: Partial<Agent> = {}): void {
    const a = this.agents.get(agentId);
    if (!a || a.status === "retired") return;
    const runs = this.agentRuns(agentId);
    const waiting = runs.some((r) => r.status === "waiting_approval") || this.hasOpenQuestion(agentId);
    const status: Agent["status"] = !a.harnessId || !online(a.harnessId) ? "offline" : waiting ? "waiting" : runs.length ? "busy" : "idle";
    const next: Agent = { ...a, ...patch, status, activeRunIds: runs.map((r) => r.id) };
    if (JSON.stringify(next) !== JSON.stringify(a)) this.upsert("agent", next);
  }

  private hasOpenQuestion(agentId: ID): boolean {
    const thread = [...this.threads.values()].find((t) => t.kind === "overseer_agent" && t.agentId === agentId);
    return !!thread && (this.messages.get(thread.id) ?? []).some((m) => m.kind === "question" && m.resolved === false);
  }

  // -- harness sources (builds + updates) -------------------------------------------

  /** Current harness code from disk, its hash and update package (cached for 5 s). */
  harnessSources(): { files: Record<string, string>; hash: string; zip: Uint8Array; sha256: string } {
    if (this.sourceCache && Date.now() - this.sourceCache.at < 5000) return this.sourceCache;
    const files: Record<string, string> = {};
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          if (name !== "__pycache__" && name !== "tests" && name !== ".venv") walk(p);
        } else files[relative(this.cfg.harnessDir, p).replace(/\\/g, "/")] = readFileSync(p, "utf8");
      }
    };
    walk(this.cfg.harnessDir);
    // Same algorithm as harness/updater.py: sha256 over "path\ncontent\n" in path order.
    const h = createHash("sha256");
    for (const f of harnessSourceFiles(files)) h.update(`${f.path}\n`).update(Buffer.from(f.content, "utf8")).update("\n");
    const zip = zipUpdatePackage(files);
    this.sourceCache = { at: Date.now(), files, hash: h.digest("hex"), zip, sha256: createHash("sha256").update(zip).digest("hex") };
    return this.sourceCache;
  }

  // -- snapshot ----------------------------------------------------------------------

  snapshot(): Snapshot {
    // The 100 most recently active board threads and their posts.
    const threads = [...this.boardThreads.values()].sort((a, b) => b.bumpedAt.localeCompare(a.bumpedAt)).slice(0, 100);
    const ids = new Set(threads.map((t) => t.id));
    return {
      harnesses: [...this.harnesses.values()],
      agents: [...this.agents.values()],
      threads: [...this.threads.values()],
      messages: [...this.messages.values()].flatMap((list) => list.slice(-200)),
      tasks: [...this.tasks.values()],
      dossiers: [...this.dossiers.values()],
      approvals: [...this.approvals.values()].filter((a) => a.status === "pending" || Date.now() - new Date(a.createdAt).getTime() < 86_400_000),
      events: this.events.slice(-500),
      metrics: this.metrics,
      settings: this.publicSettings(),
      thoughtWindows: [...this.windows.values()],
      teams: [...this.teams.values()],
      builds: [...this.builds.values()],
      boardThreads: threads,
      boardPosts: this.boardPosts.filter((p) => ids.has(p.threadId)).slice(-2000),
      guidance: [...this.guidance.values()].filter((g) => !g.removed),
    };
  }

  // -- boot ---------------------------------------------------------------------------

  /** Nothing is connected right after a restart; interrupted runs go back to the queue. */
  private recoverAfterRestart(): void {
    for (const h of this.harnesses.values()) {
      if (h.status !== "offline") {
        h.status = "offline";
        this.db.put("harnesses", h.id, h);
      }
    }
    for (const a of this.agents.values()) {
      if (a.status === "retired") continue;
      a.status = "offline";
      a.activeRunIds = [];
      this.db.put("agents", a.id, a);
    }
    for (const r of this.runs.values()) {
      if (["succeeded", "failed", "cancelled"].includes(r.status)) continue;
      r.status = "failed";
      r.endedAt = nowIso();
      this.db.put("runs", r.id, r);
      const t = this.tasks.get(r.taskId);
      if (t && !["succeeded", "failed", "cancelled"].includes(t.status)) {
        Object.assign(t, { status: "queued", attempt: t.attempt + 1, progressNote: "Requeued after overseer restart", updatedAt: nowIso() });
        this.db.put("tasks", t.id, t);
      }
    }
    for (const b of this.builds.values()) {
      if (b.status === "pending" && new Date(b.expiresAt).getTime() < Date.now()) {
        b.status = "expired";
        this.db.put("builds", b.id, b);
      }
    }
  }

  private seedIfEmpty(): void {
    if (this.teams.size) return;
    const team: Team = { id: newId("team"), name: "Main", color: "#7c8cff", mission: "General work for the operator. Rename me and set a mission in Teams.", createdAt: nowIso() };
    this.teams.set(team.id, team);
    this.db.put("teams", team.id, team);
    const thread: Thread = { id: newId("thr"), kind: "operator_overseer", teamId: team.id, title: "Main: general", createdAt: nowIso(), updatedAt: nowIso() };
    this.threads.set(thread.id, thread);
    this.db.put("threads", thread.id, thread);
    const fleet: Thread = { id: newId("thr"), kind: "operator_overseer", title: "Fleet", createdAt: nowIso(), updatedAt: nowIso() };
    this.threads.set(fleet.id, fleet);
    this.db.put("threads", fleet.id, fleet);
    const hello: Message = {
      id: newId("msg"), threadId: thread.id, role: "overseer", authorId: "overseer", createdAt: nowIso(),
      content: "Hello, I'm the Overseer. To get started:\n1. Settings → Model providers: add your DeepSeek API key.\n2. Hosts → Add host: download the Windows or Linux build and run it on a machine (any number of machines).\n3. Then tell me what you need. I spawn the agents it takes on your hosts, give them roles, and report back. Tell my helper (Helper page) how to handle things while you're away.",
    };
    this.putMessage(hello);
    this.event("info", { kind: "overseer", id: "overseer" }, "overseer.initialized", "Created team Main and a fleet thread");
  }

  providerDefinition(id: ProviderId) {
    return PROVIDERS[id];
  }
}
