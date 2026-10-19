// WebSocket message types. Documented in docs/PROTOCOL.md — keep both in sync.
import type {
  Agent,
  AgentDefinition,
  Approval,
  BoardId,
  BoardPost,
  BoardThread,
  BuildOs,
  CredentialDelivery,
  Dossier,
  EventLevel,
  Harness,
  HarnessBuild,
  HelperGuidance,
  ID,
  ISODate,
  Message,
  MetricsSnapshot,
  ProviderId,
  Run,
  ServerSettings,
  SystemEvent,
  Task,
  TaskPriority,
  TaskStatus,
  Team,
  ThoughtWindow,
  ToolGrant,
  Thread,
  Usage,
} from "./entities.js";

export const PROTOCOL_VERSION = 1;

export interface Envelope<T extends string, P> {
  v: number;
  id: ID;
  type: T;
  ts: ISODate;
  replyTo?: ID;
  payload: P;
}

// ---------------------------------------------------------------------------
// Harness channel
// ---------------------------------------------------------------------------

export type RunEvent =
  | { kind: "turn.start"; turn: number }
  | { kind: "text.delta"; text: string }
  | { kind: "thinking.update"; text: string }
  | { kind: "tool.call"; toolUseId: string; name: string; input: unknown }
  | { kind: "tool.result"; toolUseId: string; ok: boolean; output: string; durationMs: number }
  | { kind: "turn.end"; turn: number; stopReason: string; usage: Usage }
  | { kind: "progress"; fraction?: number; note: string }
  | { kind: "log"; level: EventLevel; message: string }
  | { kind: "message"; threadId: ID; content: string };

export interface Briefing {
  goal: string;
  acceptance?: string;
  dossierSummary: string;
  relatedResults: { taskId: ID; title: string; summary: string }[];
  memories: ContextItem[];
  operatorPreferences: string[];
  /** Other live agents, e.g. "Scout (Researcher, idle)", so the agent knows who to @mention. */
  teammates?: string[];
}

export interface ContextItem {
  id: ID;
  kind: "fact" | "decision" | "artifact" | "preference" | "reference" | "dossier" | "answer";
  content: string;
  score?: number;
}

/** How a harness reaches a model provider. Issued by the overseer; never configured locally. */
export interface ModelAccess {
  provider: ProviderId;
  delivery: CredentialDelivery;
  /** Gateway: <overseer>/gateway/<provider>. Direct: the provider's own base URL. */
  baseUrl: string;
  /** Gateway: short-lived harness token. Direct: the real API key. Keep in memory only. */
  token: string;
  /** Gateway tokens only. */
  expiresAt?: ISODate;
  defaultModel: string;
  models: string[];
  /** Context window in tokens; the harness compacts a run's history before reaching it. */
  contextWindow?: number;
}

export type RunSignal = "pause" | "resume" | "cancel";

export type HarnessToOverseer =
  | Envelope<
      "hello",
      {
        /** Permanent harness token (after enrollment). */
        token?: string;
        /** Single-use token from a site-generated build; exchanged for `token` in welcome. */
        enrollmentToken?: string;
        name: string;
        host: string;
        os: BuildOs;
        version: string;
        /** sha256 over the harness sources it runs; compared with the overseer's (DESIGN §4.5). */
        sourceHash?: string;
        capabilities: string[];
        slots: number;
        resumableRuns: { runId: ID; lastSeq: number }[];
      }
    >
  | Envelope<"heartbeat", { activeRunIds: ID[]; slotsUsed: number; load?: { cpu: number; memMb: number } }>
  | Envelope<"run.accepted", { runId: ID }>
  | Envelope<"run.event", { runId: ID; seq: number; event: RunEvent }>
  | Envelope<
      "run.checkpoint",
      {
        runId: ID;
        seq: number;
        turn: number;
        messageCount: number;
        /** Messages appended since the previous checkpoint (append-only delta). */
        messages: unknown[];
        /**
         * The history was compacted to fit the context window: `messages` is the whole
         * new history and replaces everything stored for this run so far.
         */
        compacted?: boolean;
        usage: Usage;
        progress?: number;
        note?: string;
      }
    >
  | Envelope<"run.status", { runId: ID; status: TaskStatus; result?: unknown; error?: { code: string; message: string } }>
  | Envelope<"context.request", { runId: ID; kind: "memory" | "dossier" | "question"; query: string; topK?: number }>
  | Envelope<"approval.request", { runId: ID; toolName: string; input: unknown; reason: string; risk: Approval["risk"] }>
  | Envelope<"task.create", { parentTaskId: ID; title: string; description: string; agentHint?: string; priority?: TaskPriority }>
  /**
   * From the agent's `reply_to_operator` tool. Accepted only while a thought window is
   * open; otherwise the overseer answers `operator.rejected` and the agent should use
   * ask_overseer. Questions get an answer via run.inject (from the operator, or from the
   * overseer after the timeout).
   */
  | Envelope<"operator.reply", { runId: ID; content: string; question: boolean }>
  /** From the `remember` tool: stored in the agent's team memory scope. */
  | Envelope<"memory.add", { runId: ID; content: string; kind: "fact" | "decision" | "reference" }>
  /** From the board tools. Answered (replyTo) with `board.response`. */
  | Envelope<"board.request", BoardRequest>
  /** From the `update_self` tool. Answered (replyTo) with HarnessUpdateInfo. */
  | Envelope<"harness.update_request", { runId?: ID }>
  | Envelope<"harness.update_status", { status: "downloading" | "applied" | "failed"; sourceHash: string; error?: string }>;

export type BoardAction =
  | { action: "read"; board?: BoardId; threadNo?: number }
  | { action: "post"; content: string; board?: BoardId; threadNo?: number; subject?: string };
export type BoardRequest = BoardAction & { runId: ID };

/** Reply to harness.update_request. */
export interface HarnessUpdateInfo {
  current: string;
  latest: string;
  upToDate: boolean;
  /** True when an update was sent / will be applied after the current runs finish. */
  scheduled: boolean;
}

export type OverseerToHarness =
  | Envelope<
      "welcome",
      {
        harnessId: ID;
        sessionId: ID;
        heartbeatMs: number;
        leaseMs: number;
        /** Only on first connect with an enrollment token: store it and use it from now on. */
        harnessToken?: string;
        /** Agents this harness hosts. Server-owned; edited on the site. */
        agents: AgentDefinition[];
        models: ModelAccess[];
      }
    >
  /** Sent when agents are added to, edited on, or removed from this harness. Replaces the set. */
  | Envelope<"agents.update", { agents: AgentDefinition[] }>
  /**
   * New harness code is available. The harness downloads `url` (Authorization: Bearer
   * <harness token>), checks `sha256` of the zip and `sourceHash` of its contents, swaps
   * it in when no runs are active, and restarts (exit code 75). See DESIGN §4.5.
   */
  | Envelope<"harness.update", { version: string; sourceHash: string; sha256: string; size: number; url: string }>
  /** Reply (replyTo) to harness.update_request. */
  | Envelope<"harness.update_info", HarnessUpdateInfo>
  | Envelope<"credentials.update", { models: ModelAccess[] }>
  | Envelope<"run.assign", { run: Run; task: Task; agentId: ID; briefing: Briefing; resumeFrom?: { seq: number; messages: unknown[] } }>
  | Envelope<"run.signal", { runId: ID; signal: RunSignal }>
  /**
   * Overseer message, operator thought, or an answer to an agent question — appended at
   * the next turn boundary. `windowOpenUntil` tells the agent until when it may use
   * reply_to_operator.
   */
  | Envelope<
      "run.inject",
      {
        runId: ID;
        /** `board`: a board post that @mentions this agent. */
        from: "overseer" | "operator_thought" | "operator_answer" | "overseer_answer" | "board";
        content: string;
        threadId: ID;
        answersMessageId?: ID;
        windowOpenUntil?: ISODate;
      }
    >
  | Envelope<"operator.rejected", { runId: ID; reason: "no_open_window" }>
  | Envelope<"run.drop", { runId: ID; reason: string }>
  | Envelope<"context.response", { items: ContextItem[] }>
  /** Reply (replyTo) to board.request: rendered text for the model. */
  | Envelope<"board.response", { ok: boolean; text: string }>
  | Envelope<"approval.response", { approved: boolean; note?: string }>
  | Envelope<"ack", { runId: ID; seq: number }>;

// ---------------------------------------------------------------------------
// Console channel
// ---------------------------------------------------------------------------

export type Topic =
  | "events"
  | "metrics"
  | "fleet"
  | "tasks"
  | `thread:${string}`
  | `agent:${string}`
  | `task:${string}`
  | `run:${string}`;

export type TaskSignal = RunSignal | "retry";

export type UiToOverseer =
  | Envelope<"subscribe", { topics: Topic[]; sinceSeq?: number }>
  | Envelope<"unsubscribe", { topics: Topic[] }>
  /** Operator → overseer only (operator_overseer threads). `answersMessageId` answers an escalation. */
  | Envelope<"message.send", { threadId: ID; content: string; answersMessageId?: ID }>
  | Envelope<"thread.create", { kind: "operator_overseer"; title?: string; teamId?: ID }>
  /**
   * Insert a thought into an agent (delivered at its next turn boundary, or next run).
   * Opens/extends the agent's thought window. `answersMessageId` answers an agent question.
   */
  | Envelope<"thought.insert", { agentId: ID; content: string; answersMessageId?: ID }>
  | Envelope<"task.create", { title: string; description: string; priority: TaskPriority; teamId: ID; agentId?: ID; role?: string; budgetTokens?: number }>
  | Envelope<"task.signal", { taskId: ID; signal: TaskSignal }>
  | Envelope<"approval.decide", { approvalId: ID; approved: boolean; note?: string }>
  | Envelope<"settings.update", { patch: SettingsPatch }>
  /** Write-only. An empty string clears the key. */
  | Envelope<"provider.setKey", { provider: ProviderId; apiKey: string }>
  | Envelope<"provider.test", { provider: ProviderId }>
  | Envelope<"team.create", TeamDraft>
  | Envelope<"team.update", { teamId: ID; patch: Partial<TeamDraft> }>
  | Envelope<"agent.move", { agentId: ID; teamId: ID }>
  /** Generate a host build (a harness to download and run on a new machine). */
  | Envelope<"host.create", { os: BuildOs; harnessName: string; overseerUrl: string }>
  /** Spawn an agent by hand. Without `harnessId` the host with the most free room is used. */
  | Envelope<"agent.spawn", AgentSpawn>
  /** Stop an agent: its runs are cancelled and it's removed from its host. */
  | Envelope<"agent.retire", { agentId: ID }>
  /** Change an agent's tool permissions and approval routes. `approvals: {}` = use the defaults. */
  | Envelope<"agent.update", { agentId: ID; tools?: ToolGrant[]; approvals?: Partial<ServerSettings["approvals"]> }>
  | Envelope<"build.revoke", { buildId: ID }>
  /** Operator post on the board. Without `threadId` a new thread is started (needs `subject`). */
  | Envelope<"board.post", { board: BoardId; content: string; threadId?: ID; subject?: string }>
  /** Standing instructions for the helper (DESIGN §5d). */
  | Envelope<"guidance.add", { content: string }>
  | Envelope<"guidance.remove", { id: ID }>
  /** Push the latest harness code to one harness now (manual update mode, or retry). */
  | Envelope<"harness.update", { harnessId: ID }>
  /**
   * Delete everything the Overseer stores (state, history, settings, keys) and restart it.
   * `confirm` must be exactly DATA_RESET_CONFIRM. Consoles reconnect and get a fresh snapshot.
   */
  | Envelope<"data.reset", { confirm: typeof DATA_RESET_CONFIRM }>;

export const DATA_RESET_CONFIRM = "delete all data";

export type TeamDraft = Omit<Team, "id" | "createdAt">;
export interface AgentSpawn {
  teamId: ID;
  role: string;
  name?: string;
  instructions?: string;
  harnessId?: ID;
}
export type { ToolGrant };

export interface SettingsPatch {
  network?: Partial<Omit<ServerSettings["network"], "advertisedUrls">>;
  updates?: Partial<ServerSettings["updates"]>;
  credentials?: Partial<ServerSettings["credentials"]>;
  chainOfCommand?: Partial<ServerSettings["chainOfCommand"]>;
  workers?: Partial<ServerSettings["workers"]>;
  autonomy?: Partial<ServerSettings["autonomy"]>;
  approvals?: Partial<ServerSettings["approvals"]>;
  defaultProvider?: ProviderId;
  providers?: { id: ProviderId; enabled?: boolean; baseUrl?: string; defaultModel?: string }[];
}
export interface Snapshot {
  harnesses: Harness[];
  agents: Agent[];
  threads: Thread[];
  messages: Message[];
  tasks: Task[];
  dossiers: Dossier[];
  approvals: Approval[];
  events: SystemEvent[];
  metrics: MetricsSnapshot[];
  settings: ServerSettings;
  thoughtWindows: ThoughtWindow[];
  teams: Team[];
  builds: HarnessBuild[];
  boardThreads: BoardThread[];
  /** Recent posts (the console fetches more per thread on demand later). */
  boardPosts: BoardPost[];
  guidance: HelperGuidance[];
}

export type EntityUpdate =
  | { kind: "harness"; entity: Harness }
  | { kind: "agent"; entity: Agent }
  | { kind: "thread"; entity: Thread }
  | { kind: "task"; entity: Task }
  | { kind: "run"; entity: Run }
  | { kind: "dossier"; entity: Dossier }
  | { kind: "approval"; entity: Approval }
  | { kind: "settings"; entity: ServerSettings }
  | { kind: "thoughtWindow"; entity: ThoughtWindow }
  | { kind: "team"; entity: Team }
  | { kind: "build"; entity: HarnessBuild }
  | { kind: "boardThread"; entity: BoardThread }
  | { kind: "guidance"; entity: HelperGuidance };

export type OverseerToUi =
  | Envelope<"snapshot", Snapshot>
  | Envelope<"event", SystemEvent>
  | Envelope<"message", Message>
  | Envelope<"board.post", BoardPost>
  | Envelope<"entity", EntityUpdate>
  | Envelope<"metrics", MetricsSnapshot>;

export type UiCommand = UiToOverseer["type"];
export type UiPayload<T extends UiCommand> = Extract<UiToOverseer, { type: T }>["payload"];
