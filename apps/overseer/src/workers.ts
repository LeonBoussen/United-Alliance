// Agents as workers (DESIGN §5f). A harness is a host with a number of seats (its
// slots); the Overseer spawns agents into free seats with a role it chooses, and
// retires them again: when their run fails or is cancelled, when they sit idle too
// long, when their host has been gone for a while, or on request.
import type { Agent, AgentDefinition, Harness, ID } from "@alliance/protocol";
import type { App } from "./app.js";
import { newId, nowIso } from "./ids.js";

/** Agents on a host that has been offline this long are retired. */
const HOST_GONE_MS = 2 * 60_000;

const NAMES = [
  "Atlas", "Forge", "Scout", "Keel", "Quill", "Sentinel", "Rook", "Vega", "Pike", "Lumen", "Cinder", "Orbit",
  "Moss", "Flint", "Echo", "Juno", "Nova", "Ridge", "Sable", "Tally", "Wren", "Haze", "Bram", "Iris",
];

export interface SpawnInput {
  teamId: ID;
  role: string;
  name?: string;
  instructions?: string;
  harnessId?: ID;
  origin: "overseer" | "operator";
}

export type SpawnResult = { ok: true; agent: Agent } | { ok: false; error: string };

export class Workers {
  /** When each agent last became idle or offline, for the reaper. */
  private since = new Map<ID, { status: Agent["status"]; at: number }>();

  constructor(private app: App) {
    setInterval(() => this.reap(), 30_000).unref();
  }

  private get core() {
    return this.app.core;
  }

  /** Free seats on a host: its slots minus the live agents on it. */
  room(h: Harness): number {
    return Math.max(0, h.slots.total - this.core.liveAgents().filter((a) => a.harnessId === h.id).length);
  }

  /** Online hosts, most free seats first. */
  hosts(): Harness[] {
    return [...this.core.harnesses.values()]
      .filter((h) => this.app.harnesses.isOnline(h.id))
      .sort((a, b) => this.room(b) - this.room(a) || a.slots.used - b.slots.used);
  }

  private uniqueName(wanted?: string): string {
    const taken = new Set(this.core.liveAgents().map((a) => a.name.toLowerCase()));
    const clean = wanted?.trim().replace(/[^\w-]/g, "").slice(0, 24);
    if (clean && !taken.has(clean.toLowerCase())) return clean;
    const free = NAMES.find((n) => !taken.has(n.toLowerCase()));
    if (free && !clean) return free;
    for (let i = 2; ; i++) {
      const n = `${clean || "Worker"}-${i}`;
      if (!taken.has(n.toLowerCase())) return n;
    }
  }

  /**
   * Retire the longest-idle spawned agent on a full host so a new one fits. Returns the
   * host with a free seat, if one could be made.
   */
  private makeRoom(): Harness | undefined {
    const idle = this.core.liveAgents()
      .filter((a) => a.origin === "overseer" && a.status === "idle" && this.app.harnesses.isOnline(a.harnessId))
      .sort((a, b) => (this.since.get(a.id)?.at ?? 0) - (this.since.get(b.id)?.at ?? 0))[0];
    if (!idle) return undefined;
    this.retire(idle.id, "made room for a new agent");
    return this.core.harnesses.get(idle.harnessId);
  }

  spawn(input: SpawnInput): SpawnResult {
    const core = this.core;
    const team = core.teams.get(input.teamId);
    if (!team) return { ok: false, error: "Unknown team." };
    const role = input.role.trim().slice(0, 120);
    if (!role) return { ok: false, error: "An agent needs a role." };
    const limits = core.settings.workers;
    if (core.liveAgents().length >= limits.maxAgents && !this.makeRoom()) {
      return { ok: false, error: `The fleet is at its limit of ${limits.maxAgents} agents (Settings → Workers). Retire one first.` };
    }

    let host: Harness | undefined;
    if (input.harnessId) {
      host = core.harnesses.get(input.harnessId);
      if (!host || !this.app.harnesses.isOnline(host.id)) return { ok: false, error: "That host isn't online." };
      if (this.room(host) === 0) return { ok: false, error: `${host.name} has no free seat (${host.slots.total} agents max).` };
    } else {
      host = this.hosts().find((h) => this.room(h) > 0) ?? this.makeRoom();
      if (!host) {
        return { ok: false, error: this.hosts().length ? "Every host is full. Retire an agent or add a host." : "No host is online. Add one under Hosts and run it on a machine." };
      }
    }

    const provider = team.defaultProvider ?? core.settings.defaultProvider;
    const def: AgentDefinition = {
      id: newId("agt"), teamId: team.id, name: this.uniqueName(input.name), role,
      effort: limits.effort, tools: limits.defaultTools, maxConcurrentRuns: 1,
      ...(input.instructions?.trim() ? { instructions: input.instructions.trim().slice(0, 4000) } : {}),
      ...(team.defaultProvider ? { provider: team.defaultProvider } : {}),
      ...(team.defaultModel ? { model: team.defaultModel } : {}),
    };
    core.saveAgentDef(def);
    const agent: Agent = {
      id: def.id, harnessId: host.id, teamId: team.id, name: def.name, role, provider,
      model: def.model ?? core.providerSettings(provider)?.defaultModel ?? "", effort: def.effort, status: "idle",
      tools: def.tools.filter((t) => t.policy !== "deny").map((t) => t.name), toolGrants: def.tools, maxConcurrentRuns: 1, activeRunIds: [],
      currentFocus: "Idle — just spawned", origin: input.origin, createdAt: nowIso(),
    };
    core.upsert("agent", agent);
    core.upsert("dossier", { agentId: agent.id, version: 1, summary: `${agent.name}: ${role}`, currentFocus: "", recentResults: [], knownFacts: [], openQuestions: [], updatedAt: nowIso() });
    core.agentThread(agent.id);
    this.app.harnesses.pushAgents(host.id);
    this.since.set(agent.id, { status: "idle", at: Date.now() });
    core.event("info", { kind: input.origin === "operator" ? "operator" : "overseer", id: input.origin === "operator" ? "op" : "overseer" }, "agent.spawned",
      `Spawned ${agent.name} (${role}) on ${host.name} for ${team.name}`, { agentId: agent.id });
    return { ok: true, agent };
  }

  /**
   * Stop an agent for good: cancel its runs (their tasks go back to the queue unless
   * they already ended), remove it from its host and mark it retired.
   */
  retire(agentId: ID, reason: string): boolean {
    const core = this.core;
    const agent = core.agents.get(agentId);
    if (!agent || agent.status === "retired") return false;
    for (const run of core.agentRuns(agentId)) {
      this.app.harnesses.send(run.harnessId, "run.signal", { runId: run.id, signal: "cancel" });
      core.upsert("run", { ...run, status: "cancelled", endedAt: nowIso() });
      const t = core.tasks.get(run.taskId);
      if (t && !["succeeded", "failed", "cancelled"].includes(t.status)) {
        const { agentId: _a, ...rest } = t;
        core.upsert("task", { ...rest, status: "queued", attempt: t.attempt + 1, progressNote: `Requeued: ${agent.name} was retired`, updatedAt: nowIso() });
      }
    }
    core.upsert("agent", { ...agent, status: "retired", activeRunIds: [], retiredAt: nowIso(), retireReason: reason, currentFocus: `Retired: ${reason}` });
    if (agent.harnessId) this.app.harnesses.pushAgents(agent.harnessId);
    this.since.delete(agentId);
    core.event("info", { kind: "overseer", id: "overseer" }, "agent.retired", `Retired ${agent.name}: ${reason}`, { agentId });
    this.app.scheduler.kick();
    return true;
  }

  /** A queued task found no agent: spawn one for it, if there is room. */
  spawnFor(task: { teamId: ID; role?: string }): Agent | undefined {
    if (!this.hosts().length) return undefined;
    const res = this.spawn({ teamId: task.teamId, role: task.role || "Generalist: does whatever the task needs", origin: "overseer" });
    return res.ok ? res.agent : undefined;
  }

  /** Retire spawned agents that sat idle too long or whose host is gone. */
  reap(): void {
    const core = this.core;
    const now = Date.now();
    const idleMs = core.settings.workers.idleRetireMinutes * 60_000;
    for (const a of core.liveAgents()) {
      const prev = this.since.get(a.id);
      if (!prev || prev.status !== a.status) {
        this.since.set(a.id, { status: a.status, at: now });
        continue;
      }
      if (a.origin !== "overseer") continue;
      if (a.status === "offline" && now - prev.at > HOST_GONE_MS) this.retire(a.id, "its host went offline");
      else if (a.status === "idle" && idleMs > 0 && now - prev.at > idleMs) this.retire(a.id, `idle for ${core.settings.workers.idleRetireMinutes} minutes`);
    }
  }
}
