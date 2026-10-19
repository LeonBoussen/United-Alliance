// The harness channel (docs/PROTOCOL.md §2): enrollment, credentials, runs, questions,
// approvals, thought windows, the board and self-updates. A harness is a host; the
// agents on it are the ones the Overseer spawned there (workers.ts).
import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type {
  AgentDefinition,
  Approval,
  HarnessToOverseer,
  HarnessUpdateInfo,
  ID,
  ModelAccess,
  OverseerToHarness,
  Task,
} from "@alliance/protocol";
import { PROTOCOL_VERSION } from "@alliance/protocol";
import type { App } from "./app.js";
import { envelope } from "./envelope.js";
import { hashToken, newId, newToken, nowIso, sameHash } from "./ids.js";

type In<T extends HarnessToOverseer["type"]> = Extract<HarnessToOverseer, { type: T }>;
type OutPayload<T extends OverseerToHarness["type"]> = Extract<OverseerToHarness, { type: T }>["payload"];

interface Session {
  harnessId: ID;
  ws: WebSocket;
  /** How this harness reaches us (from the Host header), for gateway URLs. */
  baseUrl: string;
  gatewayToken: string;
}

const GATEWAY_TOKEN_TTL = 60 * 60 * 1000;
const HEARTBEAT_MS = 10_000;

export class HarnessHub {
  readonly wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  private sessions = new Map<ID, Session>();
  private gatewayTokens = new Map<string, { harnessId: ID; exp: number }>();
  private pendingApprovals = new Map<ID, { harnessId: ID; replyTo: string; runId: ID }>();
  /** Runs we requeued while their harness was away; told to drop them when it returns. */
  private droppedRuns = new Map<ID, Set<ID>>();
  /** Thoughts for agents with no active run; delivered when the next run starts. */
  private pendingThoughts = new Map<ID, string[]>();
  private lastUsage = new Map<ID, { inputTokens: number; outputTokens: number; cacheReadTokens: number }>();

  constructor(private app: App) {
    this.wss.on("connection", (ws, req) => this.onConnection(ws, req));
    setInterval(() => this.refreshCredentials(), 20 * 60 * 1000).unref();
  }

  private get core() {
    return this.app.core;
  }

  isOnline = (harnessId: ID): boolean => this.sessions.has(harnessId);

  send<T extends OverseerToHarness["type"]>(harnessId: ID, type: T, payload: OutPayload<T>, replyTo?: string): boolean {
    const s = this.sessions.get(harnessId);
    if (!s || s.ws.readyState !== WebSocket.OPEN) return false;
    s.ws.send(JSON.stringify(envelope(type, payload, replyTo)));
    return true;
  }

  /** Gateway auth: which harness does this bearer token belong to? */
  gatewayHarness(token: string): ID | undefined {
    const t = this.gatewayTokens.get(token);
    if (!t) return undefined;
    if (t.exp < Date.now()) {
      this.gatewayTokens.delete(token);
      return undefined;
    }
    return t.harnessId;
  }

  /** Who may download update packages: a connected harness's permanent token. */
  harnessForToken(token: string): ID | undefined {
    const hash = hashToken(token);
    for (const doc of this.core.db.all<{ harnessId: ID; hash: string }>("harness_tokens")) {
      if (sameHash(doc.hash, hash)) return doc.harnessId;
    }
    return undefined;
  }

  // -- connection & enrollment ----------------------------------------------------------

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    let session: Session | undefined;
    const helloTimer = setTimeout(() => ws.close(4400, "expected hello"), 15_000);

    ws.on("message", (raw) => {
      let msg: HarnessToOverseer;
      try {
        msg = JSON.parse(String(raw)) as HarnessToOverseer;
        if (!msg || typeof msg.type !== "string" || typeof msg.payload !== "object") throw new Error("bad envelope");
      } catch {
        ws.close(4400, "malformed message");
        return;
      }
      if (!session) {
        clearTimeout(helloTimer);
        if (msg.type !== "hello") return void ws.close(4400, "expected hello");
        if (msg.v !== PROTOCOL_VERSION) return void ws.close(4426, `protocol ${PROTOCOL_VERSION} required`);
        session = this.hello(ws, req, msg as In<"hello">);
        return;
      }
      try {
        this.dispatch(session, msg);
      } catch (e) {
        this.core.event("error", { kind: "overseer", id: "overseer" }, "harness.message_error", `Error handling ${msg.type}: ${(e as Error).message}`);
      }
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (session && this.sessions.get(session.harnessId)?.ws === ws) this.disconnected(session);
    });
    ws.on("error", () => ws.terminate());
  }

  private hello(ws: WebSocket, req: IncomingMessage, msg: In<"hello">): Session | undefined {
    const p = msg.payload;
    let harnessId: ID | undefined;
    let issuedToken: string | undefined;

    if (p.token) {
      harnessId = this.harnessForToken(p.token);
    } else if (p.enrollmentToken) {
      const enrolled = this.enroll(p.enrollmentToken, p.name);
      if (enrolled) [harnessId, issuedToken] = enrolled;
    }
    if (!harnessId) {
      this.core.event("warn", { kind: "overseer", id: "overseer" }, "harness.rejected", `Rejected harness "${p.name}" from ${req.socket.remoteAddress}: invalid, used or expired token`);
      ws.close(4401, "token rejected");
      return undefined;
    }

    const old = this.sessions.get(harnessId);
    if (old) old.ws.close(4409, "replaced by a new session");

    const proto = req.headers["x-forwarded-proto"] === "https" && this.core.settings.network.trustProxy ? "https" : "http";
    const gatewayToken = this.issueGatewayToken(harnessId);
    const session: Session = { harnessId, ws, baseUrl: `${proto}://${req.headers.host}`, gatewayToken };
    this.sessions.set(harnessId, session);

    const prev = this.core.harnesses.get(harnessId);
    const latest = this.core.harnessSources().hash;
    this.core.upsert("harness", {
      id: harnessId,
      name: prev?.name ?? p.name,
      host: p.host,
      os: p.os,
      version: p.version,
      ...(p.sourceHash ? { sourceHash: p.sourceHash } : {}),
      updateAvailable: !!p.sourceHash && p.sourceHash !== latest,
      updateStatus: "idle",
      status: "online",
      capabilities: p.capabilities,
      slots: { total: p.slots, used: 0 },
      lastHeartbeatAt: nowIso(),
    });

    this.send(harnessId, "welcome", {
      harnessId,
      sessionId: newId("ses"),
      heartbeatMs: HEARTBEAT_MS,
      leaseMs: 60_000,
      ...(issuedToken ? { harnessToken: issuedToken } : {}),
      agents: this.agentDefsFor(harnessId),
      models: this.modelAccess(session),
    });

    for (const runId of p.resumableRuns.map((r) => r.runId).concat([...(this.droppedRuns.get(harnessId) ?? [])])) {
      this.send(harnessId, "run.drop", { runId, reason: "requeued while the harness was disconnected" });
    }
    this.droppedRuns.delete(harnessId);

    for (const a of this.core.agents.values()) if (a.harnessId === harnessId) this.core.refreshAgent(a.id, this.isOnline);
    this.core.event("info", { kind: "harness", id: harnessId }, issuedToken ? "harness.enrolled" : "harness.connected",
      `${issuedToken ? "Harness enrolled" : "Harness connected"}: ${p.name} (${p.host}, ${p.os}, ${p.version})`);
    if (p.sourceHash && p.sourceHash !== latest && this.core.settings.updates.mode === "automatic") this.pushUpdate(harnessId);
    this.app.scheduler.kick();
    return session;
  }

  /** Exchange a single-use enrollment token for a new harness and a permanent token. */
  private enroll(token: string, name: string): [ID, string] | undefined {
    const hash = hashToken(token);
    const build = [...this.core.builds.values()].find((b) => {
      const t = this.core.db.get<{ hash: string }>("build_tokens", b.id);
      return t && sameHash(t.hash, hash);
    });
    if (!build || build.status !== "pending" || new Date(build.expiresAt).getTime() < Date.now()) return undefined;

    const harnessId = newId("hrn");
    const permanent = newToken("hrt");
    this.core.db.put("harness_tokens", harnessId, { harnessId, hash: hashToken(permanent), createdAt: nowIso() });
    this.core.upsert("build", { ...build, status: "enrolled", harnessId });
    this.core.db.delete("build_tokens", build.id); // single use
    this.core.upsert("harness", {
      id: harnessId, name: build.harnessName || name, host: "", version: "", status: "online",
      capabilities: [], slots: { total: 0, used: 0 }, lastHeartbeatAt: nowIso(), os: build.os,
    });
    return [harnessId, permanent];
  }

  private disconnected(s: Session): void {
    this.sessions.delete(s.harnessId);
    this.gatewayTokens.delete(s.gatewayToken);
    const h = this.core.harnesses.get(s.harnessId);
    if (h) this.core.upsert("harness", { ...h, status: "offline", slots: { ...h.slots, used: 0 } });

    // Runs on this harness can't continue: requeue their tasks (no resume yet, see roadmap).
    for (const run of this.core.harnessRuns(s.harnessId)) {
      this.core.upsert("run", { ...run, status: "failed", endedAt: nowIso() });
      const set = this.droppedRuns.get(s.harnessId) ?? new Set();
      set.add(run.id);
      this.droppedRuns.set(s.harnessId, set);
      const t = this.core.tasks.get(run.taskId);
      if (t && !["succeeded", "failed", "cancelled"].includes(t.status)) {
        // Unpinned so another host can pick it up right away.
        const { agentId: _a, ...rest } = t;
        this.core.upsert("task", { ...rest, status: "queued", attempt: t.attempt + 1, progressNote: "Requeued: host disconnected", updatedAt: nowIso() });
      }
    }
    for (const a of this.core.agents.values()) if (a.harnessId === s.harnessId) this.core.refreshAgent(a.id, this.isOnline);
    this.core.event("warn", { kind: "harness", id: s.harnessId }, "harness.offline", `Harness disconnected: ${h?.name ?? s.harnessId}`);
    this.app.scheduler.kick();
  }

  // -- credentials & agents ---------------------------------------------------------------

  private issueGatewayToken(harnessId: ID): string {
    const token = newToken("uag");
    this.gatewayTokens.set(token, { harnessId, exp: Date.now() + GATEWAY_TOKEN_TTL });
    return token;
  }

  private modelAccess(s: Session): ModelAccess[] {
    const out: ModelAccess[] = [];
    for (const p of this.core.settings.providers) {
      if (!p.available || !p.enabled) continue;
      const key = this.core.providerKey(p.id);
      if (!key) continue;
      const direct = this.core.settings.credentials.delivery === "direct";
      const def = this.core.providerDefinition(p.id);
      out.push({
        provider: p.id,
        delivery: direct ? "direct" : "gateway",
        baseUrl: direct ? p.baseUrl : `${s.baseUrl}/gateway/${p.id}`,
        token: direct ? key : s.gatewayToken,
        ...(direct ? {} : { expiresAt: new Date(Date.now() + GATEWAY_TOKEN_TTL).toISOString() }),
        defaultModel: p.defaultModel,
        models: p.models,
        contextWindow: def.contextWindow,
      });
    }
    return out;
  }

  /** Re-issue gateway tokens and push model access (key/setting change or periodic refresh). */
  refreshCredentials(): void {
    for (const s of this.sessions.values()) {
      const old = s.gatewayToken;
      s.gatewayToken = this.issueGatewayToken(s.harnessId);
      // Keep the old token valid briefly so in-flight requests finish.
      const t = this.gatewayTokens.get(old);
      if (t) t.exp = Math.min(t.exp, Date.now() + 5 * 60 * 1000);
      this.send(s.harnessId, "credentials.update", { models: this.modelAccess(s) });
    }
  }

  agentDefsFor(harnessId: ID): AgentDefinition[] {
    const defs: AgentDefinition[] = [];
    for (const a of this.core.liveAgents()) {
      const d = this.core.agentDefs.get(a.id);
      if (a.harnessId === harnessId && d) {
        const team = this.core.teams.get(d.teamId);
        // Team defaults fill in what the agent doesn't set.
        defs.push({ ...d, ...(d.provider ? {} : team?.defaultProvider ? { provider: team.defaultProvider } : {}), ...(d.model ? {} : team?.defaultModel ? { model: team.defaultModel } : {}) });
      }
    }
    return defs;
  }

  pushAgents(harnessId: ID): void {
    this.send(harnessId, "agents.update", { agents: this.agentDefsFor(harnessId) });
  }

  // -- updates (DESIGN §4.5) -----------------------------------------------------------------

  pushUpdate(harnessId: ID): boolean {
    const src = this.core.harnessSources();
    const h = this.core.harnesses.get(harnessId);
    if (!h || h.sourceHash === src.hash) return false;
    const ok = this.send(harnessId, "harness.update", {
      version: src.hash.slice(0, 12), sourceHash: src.hash, sha256: src.sha256, size: src.zip.length, url: "/api/harness/package",
    });
    if (ok) {
      this.core.upsert("harness", { ...h, updateStatus: "scheduled" });
      this.core.event("info", { kind: "overseer", id: "overseer" }, "harness.update_sent", `Update ${src.hash.slice(0, 12)} sent to ${h.name}; installs when its runs finish`);
    }
    return ok;
  }

  /** Called when the harness code on disk changes: mark harnesses and push in automatic mode. */
  checkUpdates(): void {
    const latest = this.core.harnessSources().hash;
    for (const h of this.core.harnesses.values()) {
      const available = !!h.sourceHash && h.sourceHash !== latest;
      if (available !== !!h.updateAvailable) this.core.upsert("harness", { ...h, updateAvailable: available });
      if (available && this.isOnline(h.id) && this.core.settings.updates.mode === "automatic" && h.updateStatus !== "scheduled") this.pushUpdate(h.id);
    }
  }

  // -- runs ------------------------------------------------------------------------------------

  assign(run: { id: ID; agentId: ID; harnessId: ID }, task: Task, briefing: OutPayload<"run.assign">["briefing"]): boolean {
    const r = this.core.runs.get(run.id)!;
    return this.send(run.harnessId, "run.assign", { run: r, task, agentId: run.agentId, briefing });
  }

  /** Send an overseer message / operator thought to every active run of an agent. */
  injectAgent(agentId: ID, payload: Omit<OutPayload<"run.inject">, "runId">): number {
    let n = 0;
    for (const r of this.core.agentRuns(agentId)) if (this.send(r.harnessId, "run.inject", { ...payload, runId: r.id })) n++;
    if (n === 0 && payload.from === "operator_thought") {
      const q = this.pendingThoughts.get(agentId) ?? [];
      q.push(payload.content);
      this.pendingThoughts.set(agentId, q);
    }
    return n;
  }

  /** Decide an approval (by the operator, or by the route in approvals.ts) and tell the harness. */
  resolveApproval(approvalId: ID, approved: boolean, note?: string, by: NonNullable<Approval["decidedBy"]> = "operator"): boolean {
    const pending = this.pendingApprovals.get(approvalId);
    const a = this.core.approvals.get(approvalId);
    if (!a || a.status !== "pending") return false;
    this.core.upsert("approval", { ...a, status: approved ? "approved" : "denied", decidedBy: by, ...(note ? { note } : {}) });
    const agentName = this.core.agents.get(a.agentId)?.name ?? "the agent";
    const what = `${a.toolName} ${JSON.stringify(a.input).slice(0, 160)}`;
    if (by === "overseer" || by === "helper") {
      this.core.post(this.core.agentThread(a.agentId).id, by, by, `${approved ? "Approved" : "Denied"}: ${what}${note ? ` (${note})` : ""}`);
    }
    if (by === "operator") {
      // So the Overseer and helper decide the same way next time.
      this.core.addMemory({ kind: "decision", content: `Operator ${approved ? "approved" : "denied"} ${agentName}'s ${what}${note ? `: ${note}` : ""}`, scope: "global", source: { operator: true, agentId: a.agentId } });
    }
    this.core.event(approved ? "info" : "warn", { kind: by === "operator" ? "operator" : "overseer", id: by }, "approval.decided",
      `${by === "policy" ? "Auto-approved" : `${by[0]!.toUpperCase()}${by.slice(1)} ${approved ? "approved" : "denied"}`}: ${what.slice(0, 120)} for ${agentName}`, { agentId: a.agentId, taskId: a.taskId });
    this.pendingApprovals.delete(approvalId);
    if (pending) this.send(pending.harnessId, "approval.response", { approved, ...(note ? { note } : {}) }, pending.replyTo);
    const run = this.core.runs.get(a.runId);
    if (run && run.status === "waiting_approval") this.core.upsert("run", { ...run, status: "running" });
    const t = this.core.tasks.get(a.taskId);
    if (t && t.status === "waiting_approval") this.core.upsert("task", { ...t, status: "running", updatedAt: nowIso() });
    this.core.refreshAgent(a.agentId, this.isOnline);
    return true;
  }

  private dispatch(s: Session, msg: HarnessToOverseer): void {
    const core = this.core;
    const runOf = (runId: ID) => {
      const r = core.runs.get(runId);
      return r && r.harnessId === s.harnessId && !["succeeded", "failed", "cancelled"].includes(r.status) ? r : undefined;
    };

    switch (msg.type) {
      case "hello":
        return;
      case "heartbeat": {
        const h = core.harnesses.get(s.harnessId);
        if (h) core.upsert("harness", { ...h, status: "online", lastHeartbeatAt: nowIso(), slots: { ...h.slots, used: msg.payload.slotsUsed }, ...(msg.payload.load ? { load: msg.payload.load } : {}) });
        return;
      }
      case "run.accepted": {
        const r = runOf(msg.payload.runId);
        if (!r) return void this.send(s.harnessId, "run.drop", { runId: msg.payload.runId, reason: "unknown run" });
        core.upsert("run", { ...r, status: "running" });
        const t = core.tasks.get(r.taskId);
        if (t) core.upsert("task", { ...t, status: "running", startedAt: t.startedAt ?? nowIso(), progressNote: "Started", updatedAt: nowIso() });
        core.refreshAgent(r.agentId, this.isOnline, { currentFocus: t?.title ?? "" });
        for (const content of this.pendingThoughts.get(r.agentId) ?? []) {
          this.send(s.harnessId, "run.inject", { runId: r.id, from: "operator_thought", content, threadId: core.agentThread(r.agentId).id, ...this.windowField(r.agentId) });
        }
        this.pendingThoughts.delete(r.agentId);
        return;
      }
      case "run.event":
        return this.runEvent(s, msg as In<"run.event">);
      case "run.checkpoint": {
        const r = runOf(msg.payload.runId);
        if (!r) return;
        core.db.put("checkpoints", `${r.id}:${msg.payload.seq}`, { ...msg.payload, createdAt: nowIso() });
        core.upsert("run", { ...r, turn: msg.payload.turn });
        const t = core.tasks.get(r.taskId);
        if (t) core.upsert("task", { ...t, checkpointCount: t.checkpointCount + 1, updatedAt: nowIso(), ...(msg.payload.progress !== undefined ? { progress: msg.payload.progress } : {}) });
        return;
      }
      case "run.status":
        return this.runStatus(s, msg as In<"run.status">);
      case "context.request": {
        const r = runOf(msg.payload.runId);
        const agent = r ? core.agents.get(r.agentId) : undefined;
        if (!r || !agent) return void this.send(s.harnessId, "context.response", { items: [] }, msg.id);
        if (msg.payload.kind === "question") {
          core.post(core.agentThread(agent.id).id, "agent", agent.id, msg.payload.query, { runId: r.id });
          void this.app.overseer.answerAgentQuestion(agent.id, r.id, msg.payload.query).then((answer) => {
            core.post(core.agentThread(agent.id).id, "overseer", "overseer", answer, { runId: r.id });
            this.send(s.harnessId, "context.response", { items: [{ id: newId("ans"), kind: "answer", content: answer }] }, msg.id);
          });
          return;
        }
        const items = core.searchMemory(msg.payload.query, agent.teamId, msg.payload.topK ?? 5).map((m) => ({ id: m.id, kind: m.kind, content: m.content }));
        const dossier = msg.payload.kind === "dossier" ? core.dossiers.get(agent.id) : undefined;
        this.send(s.harnessId, "context.response", { items: dossier ? [{ id: `dossier:${agent.id}`, kind: "dossier", content: dossier.summary }, ...items] : items }, msg.id);
        return;
      }
      case "approval.request": {
        const r = runOf(msg.payload.runId);
        if (!r) return void this.send(s.harnessId, "approval.response", { approved: false, note: "unknown run" }, msg.id);
        const risk = this.app.approvals.riskFor(r.agentId, msg.payload.toolName, msg.payload.risk);
        const approval: Approval = {
          id: newId("apr"), runId: r.id, taskId: r.taskId, agentId: r.agentId, toolName: msg.payload.toolName, input: msg.payload.input,
          reason: msg.payload.reason, risk, status: "pending", stage: "overseer", createdAt: nowIso(),
        };
        this.pendingApprovals.set(approval.id, { harnessId: s.harnessId, replyTo: msg.id, runId: r.id });
        core.upsert("approval", approval);
        core.upsert("run", { ...r, status: "waiting_approval" });
        const t = core.tasks.get(r.taskId);
        if (t) core.upsert("task", { ...t, status: "waiting_approval", progressNote: `Needs approval: ${msg.payload.toolName}`, updatedAt: nowIso() });
        core.refreshAgent(r.agentId, this.isOnline);
        core.event("info", { kind: "agent", id: r.agentId }, "approval.requested", `${core.agents.get(r.agentId)?.name} asks to run ${msg.payload.toolName} ${JSON.stringify(msg.payload.input).slice(0, 120)} (${risk} risk)`, { agentId: r.agentId, taskId: r.taskId });
        void this.app.approvals.start(approval);
        return;
      }
      case "task.create": {
        const parent = core.tasks.get(msg.payload.parentTaskId);
        if (!parent) return;
        this.app.scheduler.createTask({
          title: msg.payload.title, description: msg.payload.description, priority: msg.payload.priority ?? "normal",
          teamId: parent.teamId, parentTaskId: parent.id, threadId: parent.threadId,
        });
        return;
      }
      case "operator.reply":
        return this.operatorReply(s, msg as In<"operator.reply">);
      case "board.request": {
        const r = runOf(msg.payload.runId);
        const agent = r ? core.agents.get(r.agentId) : undefined;
        if (!agent) return void this.send(s.harnessId, "board.response", { ok: false, text: "unknown run" }, msg.id);
        const { runId: _r, ...req } = msg.payload;
        this.send(s.harnessId, "board.response", this.app.board.handle({ kind: "agent", id: agent.id, name: agent.name }, req), msg.id);
        return;
      }
      case "memory.add": {
        const r = runOf(msg.payload.runId);
        const agent = r ? core.agents.get(r.agentId) : undefined;
        if (!agent || !msg.payload.content?.trim()) return;
        core.addMemory({ kind: msg.payload.kind, content: msg.payload.content.trim(), scope: `team:${agent.teamId}`, source: { agentId: agent.id, runId: r!.id, taskId: r!.taskId } });
        core.event("info", { kind: "agent", id: agent.id }, "memory.added", `${agent.name} remembered: ${msg.payload.content.slice(0, 100)}`, { agentId: agent.id });
        return;
      }
      case "harness.update_request": {
        const h = core.harnesses.get(s.harnessId);
        const latest = core.harnessSources().hash;
        const upToDate = h?.sourceHash === latest;
        const scheduled = !upToDate && core.settings.updates.mode === "automatic" ? (h?.updateStatus === "scheduled" || this.pushUpdate(s.harnessId)) : false;
        const info: HarnessUpdateInfo = { current: h?.sourceHash ?? "", latest, upToDate, scheduled };
        this.send(s.harnessId, "harness.update_info", info, msg.id);
        return;
      }
      case "harness.update_status": {
        const h = core.harnesses.get(s.harnessId);
        if (!h) return;
        core.upsert("harness", { ...h, updateStatus: msg.payload.status });
        const level = msg.payload.status === "failed" ? "error" : "info";
        core.event(level, { kind: "harness", id: s.harnessId }, `harness.update_${msg.payload.status}`,
          `${h.name}: update ${msg.payload.sourceHash.slice(0, 12)} ${msg.payload.status}${msg.payload.error ? `: ${msg.payload.error}` : ""}`);
        return;
      }
    }
  }

  private runEvent(s: Session, msg: In<"run.event">): void {
    const core = this.core;
    const r = core.runs.get(msg.payload.runId);
    if (!r || r.harnessId !== s.harnessId) return;
    const agent = core.agents.get(r.agentId);
    const name = agent?.name ?? r.agentId;
    const rel = { agentId: r.agentId, taskId: r.taskId, runId: r.id };
    const e = msg.payload.event;
    switch (e.kind) {
      case "progress": {
        const t = core.tasks.get(r.taskId);
        if (t) core.upsert("task", { ...t, progressNote: e.note, ...(e.fraction !== undefined ? { progress: e.fraction } : {}), updatedAt: nowIso() });
        core.event("info", { kind: "agent", id: r.agentId }, "run.progress", `${name}: ${e.note}`, rel);
        return;
      }
      case "tool.call": {
        const input = typeof e.input === "string" ? e.input : JSON.stringify(e.input);
        core.event("info", { kind: "agent", id: r.agentId }, "run.tool.call", `${name}: ${e.name} ${input.slice(0, 140)}`, rel);
        return;
      }
      case "tool.result":
        if (!e.ok) core.event("warn", { kind: "agent", id: r.agentId }, "run.tool.result", `${name}: tool failed: ${e.output.slice(0, 160)}`, rel);
        return;
      case "turn.end":
        if (core.settings.credentials.delivery === "direct") {
          // Gateway mode records usage itself; in direct mode we use the harness's (cumulative) numbers.
          const prev = this.lastUsage.get(r.id) ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
          this.lastUsage.set(r.id, { inputTokens: e.usage.inputTokens, outputTokens: e.usage.outputTokens, cacheReadTokens: e.usage.cacheReadTokens });
          core.recordUsage({
            ts: Date.now(), provider: agent?.provider ?? "deepseek", model: agent?.model ?? "", durationMs: 0, ...rel, source: "harness",
            inputTokens: Math.max(0, e.usage.inputTokens - prev.inputTokens),
            outputTokens: Math.max(0, e.usage.outputTokens - prev.outputTokens),
            cacheReadTokens: Math.max(0, e.usage.cacheReadTokens - prev.cacheReadTokens),
          });
        }
        return;
      case "log":
        core.event(e.level, { kind: "agent", id: r.agentId }, "run.log", `${name}: ${e.message}`, rel);
        return;
      case "message":
        core.post(core.agentThread(r.agentId).id, "agent", r.agentId, e.content, { runId: r.id });
        return;
      default:
        return; // text deltas / turn starts aren't stored
    }
  }

  private runStatus(s: Session, msg: In<"run.status">): void {
    const core = this.core;
    const r = core.runs.get(msg.payload.runId);
    if (!r || r.harnessId !== s.harnessId || ["succeeded", "failed", "cancelled"].includes(r.status)) return;
    const t = core.tasks.get(r.taskId);
    const agent = core.agents.get(r.agentId);
    const status = msg.payload.status;
    const rel = { agentId: r.agentId, taskId: r.taskId, runId: r.id };

    if (status === "paused" || msg.payload.error?.code === "no_slot" || msg.payload.error?.code === "unknown_agent") {
      // Couldn't start (no credentials / full / agent not loaded yet): back to the queue.
      core.upsert("run", { ...r, status: "failed", endedAt: nowIso() });
      if (t) core.upsert("task", { ...t, status: "queued", progressNote: msg.payload.error?.message ?? "Waiting", updatedAt: nowIso() });
      core.event("error", { kind: "agent", id: r.agentId }, "run.not_started", `${agent?.name}: ${msg.payload.error?.message ?? status}`, rel);
      core.refreshAgent(r.agentId, this.isOnline);
      if (msg.payload.error?.code !== "credentials_missing") setTimeout(() => this.app.scheduler.kick(), 5000);
      return;
    }
    if (!["succeeded", "failed", "cancelled"].includes(status)) {
      core.upsert("run", { ...r, status });
      return;
    }

    core.upsert("run", { ...r, status, endedAt: nowIso() });
    const name = agent?.name ?? "Agent";
    if (t) {
      const result = typeof msg.payload.result === "string" ? msg.payload.result : msg.payload.result ? JSON.stringify(msg.payload.result) : "";
      core.upsert("task", {
        ...t, status, finishedAt: nowIso(), updatedAt: nowIso(),
        ...(status === "succeeded" ? { progress: 1, progressNote: "Done" } : { progressNote: msg.payload.error?.message ?? status }),
      });
      if (status === "succeeded") {
        core.post(t.threadId, "system", "system", `${name} finished “${t.title}”:\n\n${result || "(no summary)"}`);
        const d = core.dossiers.get(r.agentId);
        if (d) core.upsert("dossier", { ...d, version: d.version + 1, recentResults: [{ taskId: t.id, outcome: "succeeded" as const, note: result.slice(0, 300) }, ...d.recentResults].slice(0, 10), currentFocus: "Idle", updatedAt: nowIso() });
        core.addMemory({ kind: "reference", content: `Result of “${t.title}” (${agent?.name}): ${result.slice(0, 800)}`, scope: `team:${t.teamId}`, source: { agentId: r.agentId, taskId: t.id, runId: r.id } });
        this.app.overseer.notify(t.threadId, `${name} finished task ${t.id} “${t.title}”. Result:\n${result.slice(0, 1500) || "(no summary)"}`);
      } else if (status === "failed") {
        core.post(t.threadId, "system", "system", `${name} couldn't finish “${t.title}”: ${msg.payload.error?.message ?? "unknown error"}.${agent?.origin === "overseer" ? ` ${name} was retired.` : ""} The Overseer can retry it with a new agent.`);
        this.app.overseer.notify(t.threadId, `${name} FAILED task ${t.id} “${t.title}”: ${msg.payload.error?.message ?? "unknown error"}.${agent?.origin === "overseer" ? ` ${name} has been retired.` : ""} Decide: retry it (signal_task retry; a fresh worker is spawned), change the approach, or tell the operator.`);
      }
    }
    core.event(status === "failed" ? "error" : "info", { kind: "agent", id: r.agentId }, `task.${status}`, `${agent?.name}: “${t?.title}” ${status}${msg.payload.error ? ` (${msg.payload.error.message})` : ""}`, rel);
    // Workers whose run stopped or errored out are retired (DESIGN §5f); the rest go idle.
    if (agent?.origin === "overseer" && status !== "succeeded") {
      this.app.workers.retire(agent.id, status === "failed" ? `its run failed: ${(msg.payload.error?.message ?? "unknown error").slice(0, 120)}` : "its run was cancelled");
    } else {
      core.refreshAgent(r.agentId, this.isOnline, { currentFocus: status === "succeeded" ? `Idle — finished “${t?.title}”` : "Idle" });
    }
    this.app.scheduler.kick();
  }

  // -- chain of command (DESIGN §5b) -------------------------------------------------------------

  windowField(agentId: ID): { windowOpenUntil?: string } {
    const w = this.core.openWindow(agentId);
    return w ? { windowOpenUntil: w.openUntil } : {};
  }

  private operatorReply(s: Session, msg: In<"operator.reply">): void {
    const core = this.core;
    const r = core.runs.get(msg.payload.runId);
    if (!r || r.harnessId !== s.harnessId) return;
    if (!core.openWindow(r.agentId)) {
      this.send(s.harnessId, "operator.rejected", { runId: r.id, reason: "no_open_window" });
      core.event("warn", { kind: "overseer", id: "overseer" }, "operator.rejected", `${core.agents.get(r.agentId)?.name} tried to reach the operator outside a thought window; redirected to the Overseer`, { agentId: r.agentId });
      return;
    }
    const thread = core.agentThread(r.agentId);
    if (!msg.payload.question) {
      core.post(thread.id, "agent", r.agentId, msg.payload.content, { kind: "reply", runId: r.id });
      return;
    }
    const minutes = core.settings.chainOfCommand.operatorAnswerTimeoutMinutes;
    const q = core.post(thread.id, "agent", r.agentId, msg.payload.content, {
      kind: "question", resolved: false, runId: r.id, answerDeadline: new Date(Date.now() + minutes * 60_000).toISOString(),
    });
    core.refreshAgent(r.agentId, this.isOnline);
    core.event("info", { kind: "agent", id: r.agentId }, "question.asked", `${core.agents.get(r.agentId)?.name} asked you a question (the Overseer answers in ${minutes} min)`, { agentId: r.agentId });
    setTimeout(() => void this.questionTimedOut(q.id), minutes * 60_000).unref();
  }

  private async questionTimedOut(messageId: ID): Promise<void> {
    const core = this.core;
    const q = core.findMessage(messageId);
    if (!q || q.resolved !== false) return;
    const agentId = q.authorId;
    const answer = await this.app.overseer.answerAgentQuestion(agentId, q.runId ?? "", q.content, { operatorTimedOut: true });
    const latest = core.findMessage(messageId);
    if (!latest || latest.resolved !== false) return; // the operator answered while we were thinking
    core.putMessage({ ...latest, resolved: true, answeredBy: "overseer" });
    core.post(q.threadId, "overseer", "overseer", answer);
    this.injectAgent(agentId, { from: "overseer_answer", content: answer, threadId: q.threadId, answersMessageId: q.id });
    core.refreshAgent(agentId, this.isOnline);
    core.event("info", { kind: "overseer", id: "overseer" }, "question.overseer_answered", `Overseer answered ${core.agents.get(agentId)?.name}'s question (operator timeout)`, { agentId });
  }
}
