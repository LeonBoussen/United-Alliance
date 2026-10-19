// The console channel (docs/PROTOCOL.md §3): snapshot + live updates out, commands in.
import { WebSocket, WebSocketServer } from "ws";
import { DATA_RESET_CONFIRM, type ApprovalRoutes, type HarnessBuild, type ID, type OverseerToUi, type TaskSignal, type ToolGrant, type UiToOverseer } from "@alliance/protocol";
import { BuildInputError, installCommand } from "@alliance/harness-kit";
import type { App } from "./app.js";
import { boardId } from "./board.js";
import { envelope } from "./envelope.js";
import { hashToken, newId, newToken, nowIso } from "./ids.js";

type Cmd<T extends UiToOverseer["type"]> = Extract<UiToOverseer, { type: T }>["payload"];

const BUILD_TTL = 24 * 60 * 60 * 1000;

/** Tool grants from the console, minus anything malformed. */
function validGrants(grants: ToolGrant[]): ToolGrant[] {
  return grants
    .filter((t) => typeof t?.name === "string" && /^[a-z_]{1,40}$/.test(t.name) && ["allow", "ask", "deny"].includes(t.policy))
    .map((t) => ({ name: t.name, policy: t.policy, ...(t.risk && ["low", "medium", "high"].includes(t.risk) ? { risk: t.risk } : {}) }));
}

/** Approval routes from the console, minus anything malformed. */
function validRoutes(routes: Partial<ApprovalRoutes>): Partial<ApprovalRoutes> {
  const out: Partial<ApprovalRoutes> = {};
  for (const risk of ["low", "medium", "high"] as const) {
    const r = routes[risk];
    if (r === "approve" || r === "overseer" || r === "operator") out[risk] = r;
  }
  return out;
}

/** A number from a settings patch, within bounds; the current value if absent or invalid. */
function clamp(v: unknown, current: number, min: number, max: number): number {
  const n = Number(v);
  return v === undefined || !Number.isFinite(n) ? current : Math.min(max, Math.max(min, Math.round(n)));
}

export class UiHub {
  readonly wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  private clients = new Set<WebSocket>();

  constructor(private app: App) {
    this.wss.on("connection", (ws) => {
      this.clients.add(ws);
      ws.on("message", (raw) => {
        let msg: UiToOverseer;
        try {
          msg = JSON.parse(String(raw)) as UiToOverseer;
          if (!msg || typeof msg.type !== "string" || typeof msg.payload !== "object" || msg.payload === null) throw new Error("bad envelope");
        } catch {
          return void ws.close(4400, "malformed message");
        }
        try {
          this.handle(ws, msg);
        } catch (e) {
          this.error(`Command ${msg.type} failed: ${(e as Error).message}`);
        }
      });
      ws.on("close", () => this.clients.delete(ws));
      ws.on("error", () => ws.terminate());
    });
  }

  private get core() {
    return this.app.core;
  }

  broadcast = (msg: OverseerToUi): void => {
    const data = JSON.stringify(msg);
    for (const ws of this.clients) if (ws.readyState === WebSocket.OPEN) ws.send(data);
  };

  private error(summary: string): void {
    this.core.event("error", { kind: "overseer", id: "overseer" }, "command.rejected", summary);
  }

  private opEvent(type: string, summary: string, rel: { agentId?: ID; taskId?: ID } = {}): void {
    this.core.event("info", { kind: "operator", id: "op" }, type, summary, rel);
  }

  private handle(ws: WebSocket, msg: UiToOverseer): void {
    const core = this.core;
    switch (msg.type) {
      case "subscribe":
        ws.send(JSON.stringify(envelope("snapshot", core.snapshot())));
        return;
      case "unsubscribe":
        return;
      case "message.send":
        return this.messageSend(msg.payload);
      case "thread.create": {
        const p = msg.payload;
        if (p.teamId && !core.teams.has(p.teamId)) return this.error("Unknown team");
        core.upsert("thread", { id: newId("thr"), kind: "operator_overseer", title: (p.title || "New conversation").slice(0, 80), createdAt: nowIso(), updatedAt: nowIso(), ...(p.teamId ? { teamId: p.teamId } : {}) });
        return;
      }
      case "thought.insert":
        return this.thought(msg.payload);
      case "task.create": {
        const p = msg.payload;
        if (!p.title?.trim()) return this.error("A task needs a title");
        if (!core.teams.has(p.teamId)) return this.error("Unknown team");
        if (p.agentId && !core.agents.has(p.agentId)) return this.error("Unknown agent");
        const t = this.app.scheduler.createTask({ ...p, title: p.title, description: p.description ?? "" });
        this.opEvent("task.created", `Operator created “${t.title}”`, { taskId: t.id });
        return;
      }
      case "task.signal":
        if (!this.signalTask(msg.payload.taskId, msg.payload.signal)) this.error("That signal doesn't apply to the task's state");
        return;
      case "approval.decide":
        if (this.app.harnesses.resolveApproval(msg.payload.approvalId, msg.payload.approved, msg.payload.note)) {
          const a = core.approvals.get(msg.payload.approvalId);
          this.opEvent("approval.decided", `${msg.payload.approved ? "Approved" : "Denied"}: ${a?.toolName} for ${core.agents.get(a?.agentId ?? "")?.name}`, { agentId: a?.agentId });
        }
        return;
      case "settings.update":
        return this.settingsUpdate(msg.payload);
      case "provider.setKey": {
        const { provider, apiKey } = msg.payload;
        if (!core.providerSettings(provider)) return this.error("Unknown provider");
        if (core.lockedSettings().includes(`providers.${provider}.key`)) return this.error(`The ${provider} key is set by an environment variable`);
        core.setProviderKey(provider, apiKey.trim());
        this.app.harnesses.refreshCredentials();
        this.opEvent("provider.key", `${apiKey.trim() ? "Set" : "Cleared"} the API key for ${provider}`);
        this.app.scheduler.kick();
        return;
      }
      case "provider.test":
        void this.testProvider(msg.payload.provider);
        return;
      case "team.create": {
        const p = msg.payload;
        if (!p.name?.trim() || !p.mission?.trim()) return this.error("A team needs a name and a mission");
        const team = { ...p, name: p.name.trim().slice(0, 40), id: newId("team"), createdAt: nowIso() };
        core.upsert("team", team);
        core.teamThread(team.id);
        this.opEvent("team.created", `Team created: ${team.name}`);
        return;
      }
      case "team.update": {
        const team = core.teams.get(msg.payload.teamId);
        if (!team) return this.error("Unknown team");
        core.upsert("team", { ...team, ...msg.payload.patch, id: team.id, createdAt: team.createdAt });
        for (const a of core.agents.values()) if (a.teamId === team.id && a.harnessId) this.app.harnesses.pushAgents(a.harnessId);
        this.opEvent("team.updated", `Team updated: ${team.name}`);
        return;
      }
      case "agent.move": {
        const agent = core.agents.get(msg.payload.agentId);
        const def = core.agentDefs.get(msg.payload.agentId);
        const team = core.teams.get(msg.payload.teamId);
        if (!agent || !def || !team) return this.error("Unknown agent or team");
        core.saveAgentDef({ ...def, teamId: team.id });
        core.upsert("agent", { ...agent, teamId: team.id });
        if (agent.harnessId) this.app.harnesses.pushAgents(agent.harnessId);
        this.opEvent("agent.moved", `${agent.name} moved to ${team.name}`, { agentId: agent.id });
        return;
      }
      case "host.create":
        return this.hostCreate(msg.payload);
      case "agent.spawn": {
        const p = msg.payload;
        const res = this.app.workers.spawn({
          teamId: p.teamId, role: p.role ?? "", origin: "operator",
          ...(p.name ? { name: p.name } : {}), ...(p.instructions ? { instructions: p.instructions } : {}), ...(p.harnessId ? { harnessId: p.harnessId } : {}),
        });
        if (!res.ok) return this.error(`Agent not spawned: ${res.error}`);
        this.app.scheduler.kick();
        return;
      }
      case "agent.update": {
        const p = msg.payload;
        const agent = core.agents.get(p.agentId);
        const def = core.agentDefs.get(p.agentId);
        if (!agent || !def || agent.status === "retired") return this.error("Unknown or retired agent");
        const tools = p.tools ? validGrants(p.tools) : def.tools;
        const approvals = p.approvals ? validRoutes(p.approvals) : def.approvals ?? {};
        const { approvals: _old, ...rest } = def;
        core.saveAgentDef({ ...rest, tools, ...(Object.keys(approvals).length ? { approvals } : {}) });
        const { approvals: _a, ...agentRest } = agent;
        core.upsert("agent", { ...agentRest, toolGrants: tools, tools: tools.filter((t) => t.policy !== "deny").map((t) => t.name), ...(Object.keys(approvals).length ? { approvals } : {}) });
        if (agent.harnessId) this.app.harnesses.pushAgents(agent.harnessId);
        this.opEvent("agent.updated", `Permissions changed for ${agent.name}`, { agentId: agent.id });
        return;
      }
      case "agent.retire": {
        const agent = core.agents.get(msg.payload.agentId);
        if (!agent || agent.status === "retired") return this.error("Unknown or already retired agent");
        this.app.workers.retire(agent.id, "retired by the operator");
        return;
      }
      case "board.post": {
        const p = msg.payload;
        const board = boardId(p.board);
        if (!board) return this.error("Unknown board");
        const res = this.app.board.post({ kind: "operator", id: "op", name: "Operator" }, {
          board, content: p.content ?? "", ...(p.threadId ? { threadId: p.threadId } : {}), ...(p.subject ? { subject: p.subject } : {}),
        });
        if (!res.ok) this.error(res.error);
        return;
      }
      case "guidance.add": {
        const content = msg.payload.content?.trim().slice(0, 1000);
        if (!content) return;
        core.upsert("guidance", { id: newId("gdn"), content, createdAt: nowIso() });
        this.opEvent("guidance.added", `Guidance for the helper: ${content.slice(0, 80)}`);
        return;
      }
      case "guidance.remove": {
        const g = core.guidance.get(msg.payload.id);
        if (g && !g.removed) core.upsert("guidance", { ...g, removed: true });
        return;
      }
      case "build.revoke": {
        const b = core.builds.get(msg.payload.buildId);
        if (!b || b.status !== "pending") return;
        core.upsert("build", { ...b, status: "revoked" });
        core.db.delete("build_tokens", b.id);
        this.opEvent("build.revoked", `Revoked the build for ${b.harnessName}`);
        return;
      }
      case "harness.update": {
        const h = core.harnesses.get(msg.payload.harnessId);
        if (!h) return this.error("Unknown harness");
        if (!this.app.harnesses.isOnline(h.id)) return this.error(`${h.name} is offline`);
        if (!this.app.harnesses.pushUpdate(h.id)) this.opEvent("harness.update", `${h.name} is already up to date`);
        return;
      }
      case "data.reset":
        if (msg.payload.confirm !== DATA_RESET_CONFIRM) return this.error("Data not removed: the confirmation didn't match");
        this.app.resetAllData();
        return;
    }
  }

  // -- commands ----------------------------------------------------------------------

  private messageSend(p: Cmd<"message.send">): void {
    const core = this.core;
    const thread = core.threads.get(p.threadId);
    if (!thread || (thread.kind !== "operator_overseer" && thread.kind !== "operator_helper")) return this.error("Operators can only message the Overseer and its helper");
    const content = p.content?.trim();
    if (!content) return;
    core.post(thread.id, "operator", "op", content);
    if (thread.kind === "operator_helper") {
      if (p.answersMessageId && this.app.helper.resolveEscalation(p.answersMessageId, content)) return;
      this.app.helper.replyInThread(thread.id);
      return;
    }
    if (p.answersMessageId && (this.app.helper.resolveEscalation(p.answersMessageId, content) || this.app.overseer.resolveEscalation(p.answersMessageId, content))) return;
    this.app.overseer.replyInThread(thread.id);
  }

  private thought(p: Cmd<"thought.insert">): void {
    const core = this.core;
    const agent = core.agents.get(p.agentId);
    const content = p.content?.trim();
    if (!agent || !content) return;
    const thread = core.agentThread(agent.id);
    core.post(thread.id, "operator", "op", content, { kind: "thought" });

    const minutes = core.settings.chainOfCommand.thoughtWindowMinutes;
    const prev = core.openWindow(agent.id);
    const window = { agentId: agent.id, openedAt: prev?.openedAt ?? nowIso(), openUntil: new Date(Date.now() + minutes * 60_000).toISOString() };
    core.upsert("thoughtWindow", window);

    const question = p.answersMessageId ? core.findMessage(p.answersMessageId) : undefined;
    if (question && question.kind === "question" && question.resolved === false) {
      core.putMessage({ ...question, resolved: true, answeredBy: "operator" });
      this.app.harnesses.injectAgent(agent.id, { from: "operator_answer", content, threadId: thread.id, answersMessageId: question.id, windowOpenUntil: window.openUntil });
      core.refreshAgent(agent.id, this.app.harnesses.isOnline);
      this.opEvent("question.answered", `Operator answered ${agent.name}'s question`, { agentId: agent.id });
      return;
    }
    const delivered = this.app.harnesses.injectAgent(agent.id, { from: "operator_thought", content, threadId: thread.id, windowOpenUntil: window.openUntil });
    this.opEvent("thought.inserted", `Thought inserted into ${agent.name}${delivered ? "" : " (queued for its next task)"}`, { agentId: agent.id });
  }

  signalTask(taskId: ID, signal: TaskSignal): boolean {
    const core = this.core;
    const t = core.tasks.get(taskId);
    if (!t) return false;
    const run = [...core.runs.values()].find((r) => r.taskId === t.id && !["succeeded", "failed", "cancelled"].includes(r.status));
    const send = (s: "pause" | "resume" | "cancel") => run && this.app.harnesses.send(run.harnessId, "run.signal", { runId: run.id, signal: s });
    switch (signal) {
      case "pause":
        if (!run) return false;
        send("pause");
        core.upsert("run", { ...run, status: "paused" });
        core.upsert("task", { ...t, status: "paused", updatedAt: nowIso() });
        break;
      case "resume":
        if (t.status !== "paused" || !run) return false;
        send("resume");
        core.upsert("run", { ...run, status: "running" });
        core.upsert("task", { ...t, status: "running", updatedAt: nowIso() });
        break;
      case "cancel":
        if (["succeeded", "failed", "cancelled"].includes(t.status)) return false;
        send("cancel");
        if (run) core.upsert("run", { ...run, status: "cancelled", endedAt: nowIso() });
        core.upsert("task", { ...t, status: "cancelled", finishedAt: nowIso(), updatedAt: nowIso() });
        break;
      case "retry":
        if (!["failed", "cancelled"].includes(t.status)) return false;
        core.upsert("task", { ...t, status: "queued", attempt: t.attempt + 1, progress: 0, progressNote: "Retrying", updatedAt: nowIso() });
        this.app.scheduler.kick();
        break;
    }
    if (run) core.refreshAgent(run.agentId, this.app.harnesses.isOnline);
    this.opEvent("task.signal", `Operator: ${signal} “${t.title}”`, { taskId: t.id });
    return true;
  }

  private settingsUpdate(p: Cmd<"settings.update">): void {
    const core = this.core;
    const patch = p.patch;
    const locked = core.lockedSettings();
    if (patch.network?.allowPublic !== undefined && patch.network.allowPublic !== core.settings.network.allowPublic) {
      if (locked.includes("network.allowPublic")) return this.error("Public access is set by ALLIANCE_ALLOW_PUBLIC");
      if (patch.network.allowPublic && !core.publicSettings().operatorAuthConfigured) return this.error("Public access refused: configure operator login first");
    }
    if (patch.network?.extraAllowedCidrs) {
      for (const c of patch.network.extraAllowedCidrs) if (!/^[0-9a-fA-F:.]+\/\d{1,3}$/.test(c)) return this.error(`Not a valid range: ${c}`);
    }
    const s = core.settings;
    const { bindHost: _b, port: _p, ...network } = patch.network ?? {};
    core.settings = {
      ...s,
      network: { ...s.network, ...network },
      credentials: { ...s.credentials, ...patch.credentials },
      updates: { ...s.updates, ...patch.updates },
      chainOfCommand: {
        thoughtWindowMinutes: Math.min(240, Math.max(1, Number(patch.chainOfCommand?.thoughtWindowMinutes ?? s.chainOfCommand.thoughtWindowMinutes))),
        operatorAnswerTimeoutMinutes: Math.min(120, Math.max(1, Number(patch.chainOfCommand?.operatorAnswerTimeoutMinutes ?? s.chainOfCommand.operatorAnswerTimeoutMinutes))),
      },
      workers: {
        maxAgents: clamp(patch.workers?.maxAgents, s.workers.maxAgents, 1, 200),
        idleRetireMinutes: clamp(patch.workers?.idleRetireMinutes, s.workers.idleRetireMinutes, 0, 24 * 60),
        effort: patch.workers?.effort ?? s.workers.effort,
        defaultTools: patch.workers?.defaultTools ? validGrants(patch.workers.defaultTools) : s.workers.defaultTools,
      },
      approvals: { ...s.approvals, ...(patch.approvals ? validRoutes(patch.approvals) : {}) },
      autonomy: {
        followUps: patch.autonomy?.followUps ?? s.autonomy.followUps,
        maxFollowUpsPerHour: clamp(patch.autonomy?.maxFollowUpsPerHour, s.autonomy.maxFollowUpsPerHour, 1, 200),
      },
      defaultProvider: patch.defaultProvider ?? s.defaultProvider,
      providers: s.providers.map((pr) => {
        const u = patch.providers?.find((x) => x.id === pr.id);
        if (!u) return pr;
        if (u.baseUrl !== undefined && !/^https?:\/\/\S+$/.test(u.baseUrl)) return pr;
        return { ...pr, ...(u.enabled !== undefined ? { enabled: u.enabled } : {}), ...(u.baseUrl ? { baseUrl: u.baseUrl.replace(/\/$/, "") } : {}), ...(u.defaultModel ? { defaultModel: u.defaultModel } : {}) };
      }),
    };
    core.saveSettings();
    this.app.onNetworkChange();
    if (patch.credentials || patch.providers || patch.defaultProvider) this.app.harnesses.refreshCredentials();
    if (patch.updates?.mode === "automatic") this.app.harnesses.checkUpdates();
    if (patch.workers?.defaultTools) for (const h of core.harnesses.values()) this.app.harnesses.pushAgents(h.id);
    this.opEvent("settings.updated", `Settings updated (${Object.keys(patch).join(", ")})`);
  }

  private async testProvider(provider: Cmd<"provider.test">["provider"]): Promise<void> {
    const core = this.core;
    const p = core.providerSettings(provider);
    const key = core.providerKey(provider);
    const src = { kind: "overseer" as const, id: "overseer" };
    if (!p) return;
    if (!key) return void core.event("error", src, "provider.test", `${p.label}: no API key set`);
    const started = Date.now();
    try {
      const def = core.providerDefinition(provider);
      const res = await fetch(`${p.baseUrl}${def.testPath}`, {
        headers: def.auth.header === "authorization" ? { authorization: `Bearer ${key}` } : { "x-api-key": key },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.status === 401 ? "(invalid key)" : ""}`.trim());
      const body = (await res.json().catch(() => ({}))) as { data?: { id: string }[] };
      const models = body.data?.map((m) => m.id) ?? [];
      core.event("info", src, "provider.test", `${p.label}: connection OK (${Date.now() - started} ms${models.length ? `, models: ${models.slice(0, 6).join(", ")}` : ""})`);
    } catch (e) {
      core.event("error", src, "provider.test", `${p.label}: ${(e as Error).message}`);
    }
  }

  /** A host build: a harness to download and run on a new machine. Agents come later, spawned by the Overseer. */
  private hostCreate(p: Cmd<"host.create">): void {
    const core = this.core;
    const name = (p.harnessName ?? "").trim().slice(0, 40);
    if (!name) return this.error("A host needs a name");
    const buildId = newId("bld");
    const token = newToken("enr");
    const base = (p.overseerUrl ?? "").replace(/\/$/, "");
    let command: string;
    try {
      command = installCommand({ id: buildId, os: p.os }, base, token);
    } catch (e) {
      return this.error(`Host build not created: ${e instanceof BuildInputError ? e.message : String(e)}`);
    }
    const build: HarnessBuild = {
      id: buildId, os: p.os, harnessName: name, overseerUrl: base,
      status: "pending", createdAt: nowIso(), expiresAt: new Date(Date.now() + BUILD_TTL).toISOString(),
      downloadUrl: `${base}/api/builds/${buildId}/download?t=${token}`, installCommand: command,
    };
    // The token is needed again to regenerate the zip, so it's kept encrypted (plus a hash for checks).
    core.db.put("build_tokens", buildId, { hash: hashToken(token), enc: core.secrets.encrypt(token) });
    core.upsert("build", build);
    this.opEvent("build.created", `${p.os === "windows" ? "Windows" : "Linux"} host build for ${name}, waiting for it to connect`);
  }
}
