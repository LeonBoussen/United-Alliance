// Domain entities shared by the overseer, harnesses and the console.
// Field names match the wire format (camelCase). See docs/DATA_MODEL.md.

export type ID = string;
export type ISODate = string;

export type HarnessStatus = "online" | "degraded" | "offline";
/** `retired`: the agent was stopped (failed, cancelled, idle too long, host gone, or by hand) and no longer exists on a host. */
export type AgentStatus = "idle" | "busy" | "waiting" | "offline" | "error" | "retired";
export type TaskStatus =
  | "queued"
  | "assigned"
  | "running"
  | "paused"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled";
export type TaskPriority = "low" | "normal" | "high" | "urgent";
/**
 * Chain of command (DESIGN §5b): the operator talks to the overseer; the overseer talks
 * to agents. The operator reaches an agent by inserting a thought into its thread
 * (`overseer_agent`). A thought opens a short window in which the agent may reply to
 * the operator and ask questions; outside it, agents can only ask the overseer.
 */
export type ThreadKind = "operator_overseer" | "overseer_agent" | "operator_helper";
/** `helper`: the Overseer's helper, which speaks for the operator (DESIGN §5d). */
export type MessageRole = "operator" | "overseer" | "agent" | "system" | "tool" | "helper";
/**
 * `thought`: operator insert into an agent (or the operator's answer to an agent question).
 * `reply`: agent → operator inside an open thought window.
 * `question`: agent → operator inside a window; the overseer answers if the operator doesn't in time.
 * `escalation`: overseer question that only the operator can answer.
 */
export type MessageKind = "chat" | "thought" | "reply" | "question" | "escalation";
export type ProviderId = "deepseek" | "anthropic" | "openai";
export type CredentialDelivery = "gateway" | "direct";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type EventLevel = "debug" | "info" | "warn" | "error";
export type SourceKind = "overseer" | "harness" | "agent" | "operator";

export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = [
  "assigned",
  "running",
  "paused",
  "waiting_approval",
];

export type BuildOs = "windows" | "linux";
export type ToolPolicy = "allow" | "ask" | "deny";
export type Risk = "low" | "medium" | "high";
/**
 * Who decides a tool call that needs approval (policy "ask"), by its risk (DESIGN §5b.4):
 * `approve` = approved automatically; `overseer` = the Overseer decides, asks its helper
 * if unsure, and only then the operator; `operator` = always the operator.
 */
export type ApprovalRoute = "approve" | "overseer" | "operator";
export type ApprovalRoutes = Record<Risk, ApprovalRoute>;

/**
 * A team: a group of agents with its own mission, budget, memory scope and its own
 * overseer context (DESIGN §5c). Agents belong to exactly one team; a harness can host
 * agents from several teams.
 */
export interface Team {
  id: ID;
  name: string;
  mission: string;
  /** Accent used for the team's chips in the console. */
  color: string;
  /** Extra instructions for the overseer when it works for this team. */
  leadInstructions?: string;
  defaultProvider?: ProviderId;
  defaultModel?: string;
  budget?: { dailyTokens?: number; dailyUsd?: number };
  createdAt: ISODate;
}

export interface ToolGrant {
  name: string;
  policy: ToolPolicy;
  /** Overrides the tool's built-in risk; picks the approval route. */
  risk?: Risk;
}

/** Server-owned agent definition, sent to the hosting harness. Edited on the site. */
export interface AgentDefinition {
  id: ID;
  teamId: ID;
  name: string;
  role: string;
  instructions?: string;
  /** Omit to use the team's, then the server's default. */
  provider?: ProviderId;
  model?: string;
  effort: Effort;
  tools: ToolGrant[];
  maxConcurrentRuns: number;
  /** Per-agent approval routes; unset risks use the server's (Settings → Approvals). */
  approvals?: Partial<ApprovalRoutes>;
}

/**
 * A downloadable harness package generated on the site (DESIGN §4.4). A harness is a
 * host: it runs whatever agents the Overseer spawns on it, so a build names no agents.
 */
export interface HarnessBuild {
  id: ID;
  os: BuildOs;
  harnessName: string;
  /** URL the harness will use to reach the overseer. */
  overseerUrl: string;
  status: "pending" | "enrolled" | "expired" | "revoked";
  /** Set once the harness has enrolled. */
  harnessId?: ID;
  createdAt: ISODate;
  /** The single-use enrollment token expires at this time. */
  expiresAt: ISODate;
  downloadUrl: string;
  /** One-line installer for the target OS (PowerShell or bash). */
  installCommand: string;
}

export interface Harness {
  id: ID;
  name: string;
  host: string;
  os?: BuildOs;
  version: string;
  /** sha256 over the harness sources it runs (DESIGN §4.5). */
  sourceHash?: string;
  /** True when the overseer has newer harness sources than this harness runs. */
  updateAvailable?: boolean;
  updateStatus?: "idle" | "scheduled" | "downloading" | "applied" | "failed";
  status: HarnessStatus;
  capabilities: string[];
  slots: { total: number; used: number };
  load?: { cpu: number; memMb: number };
  lastHeartbeatAt: ISODate;
}

export interface Agent {
  id: ID;
  harnessId: ID;
  teamId: ID;
  name: string;
  role: string;
  provider: ProviderId;
  model: string;
  effort: Effort;
  status: AgentStatus;
  tools: string[];
  /** The agent's tool grants with policy and risk (editable on its Permissions tab). */
  toolGrants?: ToolGrant[];
  /** Per-agent approval routes; unset risks use the server's. */
  approvals?: Partial<ApprovalRoutes>;
  maxConcurrentRuns: number;
  activeRunIds: ID[];
  currentFocus?: string;
  /** Who created it: spawned by the Overseer (retired automatically) or by the operator. */
  origin?: "overseer" | "operator";
  createdAt?: ISODate;
  retiredAt?: ISODate;
  retireReason?: string;
}

export interface Thread {
  id: ID;
  kind: ThreadKind;
  /** operator_overseer: the team this conversation is about; unset = fleet-wide. */
  teamId?: ID;
  title: string;
  agentId?: ID;
  taskId?: ID;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface Message {
  id: ID;
  threadId: ID;
  role: MessageRole;
  authorId: ID;
  content: string;
  createdAt: ISODate;
  kind?: MessageKind;
  runId?: ID;
  /** True while the message is still streaming in. */
  partial?: boolean;
  /** Questions and escalations: set once answered. */
  resolved?: boolean;
  /** Agent questions: when the overseer takes over if the operator hasn't answered. */
  answerDeadline?: ISODate;
  /** Agent questions: who answered. */
  answeredBy?: "operator" | "overseer";
}

/** Per-agent window opened by an operator thought (DESIGN §5b.3). */
export interface ThoughtWindow {
  agentId: ID;
  openedAt: ISODate;
  /** Extended by each new thought or operator answer. */
  openUntil: ISODate;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

export interface TaskBudget {
  tokens?: number;
  usd?: number;
  seconds?: number;
}

export interface Task {
  id: ID;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  teamId: ID;
  threadId: ID;
  agentId?: ID;
  /** Role for the worker the scheduler spawns when no agent is free (e.g. "Researcher"). */
  role?: string;
  parentTaskId?: ID;
  progress?: number;
  progressNote?: string;
  budget?: TaskBudget;
  usedTokens: number;
  usedUsd: number;
  attempt: number;
  checkpointCount: number;
  createdAt: ISODate;
  updatedAt: ISODate;
  startedAt?: ISODate;
  finishedAt?: ISODate;
}

export interface Run {
  id: ID;
  taskId: ID;
  agentId: ID;
  attempt: number;
  status: TaskStatus;
  turn: number;
  startedAt: ISODate;
  endedAt?: ISODate;
  usage: Usage;
}

export interface Dossier {
  agentId: ID;
  version: number;
  summary: string;
  currentFocus: string;
  recentResults: { taskId: ID; outcome: "succeeded" | "failed" | "cancelled"; note: string }[];
  knownFacts: string[];
  openQuestions: string[];
  updatedAt: ISODate;
}

export interface Approval {
  id: ID;
  runId: ID;
  taskId: ID;
  agentId: ID;
  toolName: string;
  input: unknown;
  reason: string;
  risk: Risk;
  status: "pending" | "approved" | "denied" | "expired";
  /** Who is deciding a pending approval. Only `operator` stage shows up under Needs you. */
  stage?: "overseer" | "helper" | "operator";
  decidedBy?: "policy" | "overseer" | "helper" | "operator";
  /** The Overseer's / helper's short verdicts, e.g. "Overseer: unsure — touches production". */
  reviewNotes?: string[];
  /** Reason given with the decision; passed to the agent. */
  note?: string;
  createdAt: ISODate;
}

export interface SystemEvent {
  seq: number;
  id: ID;
  ts: ISODate;
  level: EventLevel;
  source: { kind: SourceKind; id: ID };
  type: string;
  summary: string;
  runId?: ID;
  taskId?: ID;
  agentId?: ID;
  threadId?: ID;
  data?: Record<string, unknown>;
}

/**
 * The message board (DESIGN §5e): an imageboard-style place where agents, the Overseer,
 * the helper and the operator talk in the open. Boards hold threads; threads hold posts.
 * Post numbers are global and increasing, so `>>123` always means one post.
 */
export const BOARDS = [
  { id: "general", title: "General", description: "Coordination, status and anything that fits nowhere else" },
  { id: "work", title: "Work", description: "One thread per piece of work: plans, progress, hand-offs" },
  { id: "help", title: "Help", description: "Ask other agents for help or information" },
  { id: "results", title: "Results", description: "Findings and finished results worth sharing" },
] as const;
export type BoardId = (typeof BOARDS)[number]["id"];
export type BoardAuthorKind = "agent" | "overseer" | "helper" | "operator";

export interface BoardThread {
  id: ID;
  board: BoardId;
  /** Number of the opening post. */
  no: number;
  subject: string;
  authorKind: BoardAuthorKind;
  authorId: ID;
  authorName: string;
  createdAt: ISODate;
  /** Last reply time; threads are listed by this (newest first). */
  bumpedAt: ISODate;
  replyCount: number;
  teamId?: ID;
  taskId?: ID;
}

export interface BoardPost {
  id: ID;
  no: number;
  threadId: ID;
  board: BoardId;
  authorKind: BoardAuthorKind;
  authorId: ID;
  authorName: string;
  content: string;
  createdAt: ISODate;
}

/** A standing instruction from the operator to the helper (DESIGN §5d). */
export interface HelperGuidance {
  id: ID;
  content: string;
  createdAt: ISODate;
  /** Set when removed; consoles drop it. */
  removed?: boolean;
}

export interface ProviderSettings {
  id: ProviderId;
  label: string;
  /** False for providers whose adapter isn't built yet ("coming later"). */
  available: boolean;
  enabled: boolean;
  baseUrl: string;
  defaultModel: string;
  models: string[];
  /** Keys are write-only: the console only learns whether one is set and a short hint. */
  keySet: boolean;
  keyHint?: string;
  keyUpdatedAt?: ISODate;
}

export interface ServerSettings {
  network: {
    /** Off by default: only loopback and private ranges may connect. */
    allowPublic: boolean;
    bindHost: string;
    port: number;
    extraAllowedCidrs: string[];
    trustProxy: boolean;
    /** Addresses harnesses on this network can use to reach the overseer (computed). */
    advertisedUrls: string[];
  };
  credentials: { delivery: CredentialDelivery };
  /** How harnesses get new versions of the harness code (DESIGN §4.5). */
  updates: { mode: "automatic" | "manual" };
  chainOfCommand: {
    /** How long after a thought the agent may reply to / ask the operator. */
    thoughtWindowMinutes: number;
    /** How long the operator has to answer an agent question before the overseer answers. */
    operatorAnswerTimeoutMinutes: number;
  };
  /** Agents the Overseer spawns on hosts (DESIGN §5f). */
  workers: {
    /** Upper bound on live (non-retired) agents across all hosts. */
    maxAgents: number;
    /** Spawned agents idle this long are retired. 0 = never. */
    idleRetireMinutes: number;
    /** Tool grants every spawned agent gets. */
    defaultTools: ToolGrant[];
    effort: Effort;
  };
  /** Who decides tool calls that need approval, per risk level. */
  approvals: ApprovalRoutes;
  /** How much the Overseer acts on its own between operator messages. */
  autonomy: {
    /** Wake the Overseer when a task it delegated finishes, fails or its agent retires. */
    followUps: boolean;
    /** Cap on such wake-ups per conversation per hour. */
    maxFollowUpsPerHour: number;
  };
  defaultProvider: ProviderId;
  providers: ProviderSettings[];
  /** Setting paths fixed by environment variables, e.g. "network.allowPublic". */
  locked: string[];
  /** Whether operator login is configured (required before allowing public access). */
  operatorAuthConfigured: boolean;
}

export interface MetricsSnapshot {
  ts: ISODate;
  agentsOnline: number;
  agentsTotal: number;
  runsActive: number;
  tasksQueued: number;
  tokensPerMin: number;
  costTodayUsd: number;
  errorRate: number;
  p50LatencyMs: number;
}
