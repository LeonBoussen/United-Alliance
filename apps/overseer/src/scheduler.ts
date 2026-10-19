// Task engine (DESIGN §6): creates tasks and assigns queued ones to available agents,
// spawning a worker on a host when no fitting agent is free.
import type { Briefing, ID, Task, TaskPriority } from "@alliance/protocol";
import type { App } from "./app.js";
import type { ActiveRun } from "./core.js";
import { newId, nowIso } from "./ids.js";

const PRIORITY: Record<TaskPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

export interface TaskInput {
  title: string;
  description: string;
  priority: TaskPriority;
  teamId: ID;
  agentId?: ID;
  /** Role of the worker to spawn if no fitting agent is free. */
  role?: string;
  budgetTokens?: number;
  parentTaskId?: ID;
  threadId?: ID;
}

export class Scheduler {
  private timer?: NodeJS.Timeout;

  constructor(private app: App) {
    // Safety net: retry periodically in case a kick was missed (e.g. a slot freed up).
    setInterval(() => this.kick(), 15_000).unref();
  }

  createTask(input: TaskInput): Task {
    const core = this.app.core;
    const task: Task = {
      id: newId("tsk"),
      title: input.title.trim(),
      description: input.description.trim(),
      status: "queued",
      priority: input.priority,
      teamId: input.teamId,
      threadId: input.threadId ?? core.teamThread(input.teamId).id,
      usedTokens: 0,
      usedUsd: 0,
      attempt: 1,
      checkpointCount: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.role?.trim() ? { role: input.role.trim().slice(0, 120) } : {}),
      ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      ...(input.budgetTokens ? { budget: { tokens: input.budgetTokens } } : {}),
    };
    core.upsert("task", task);
    core.event("info", { kind: "overseer", id: "overseer" }, "task.created", `Task created: ${task.title}`, { taskId: task.id });
    this.kick();
    return task;
  }

  kick(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.assign();
    }, 150);
  }

  private assign(): void {
    const { core, harnesses } = this.app;
    const queued = [...core.tasks.values()]
      .filter((t) => t.status === "queued")
      .sort((a, b) => PRIORITY[a.priority] - PRIORITY[b.priority] || a.createdAt.localeCompare(b.createdAt));

    for (const task of queued) {
      // A task pinned to an agent that has since been retired is free for anyone.
      const pinned = task.agentId && core.agents.get(task.agentId)?.status !== "retired" ? task.agentId : undefined;
      const candidates = core.liveAgents().filter((a) => {
        if (pinned ? a.id !== pinned : a.teamId !== task.teamId) return false;
        if (!a.harnessId || !harnesses.isOnline(a.harnessId) || !core.agentDefs.has(a.id)) return false;
        if (core.agentRuns(a.id).length >= a.maxConcurrentRuns) return false;
        const h = core.harnesses.get(a.harnessId);
        return !!h && core.harnessRuns(a.harnessId).length < Math.max(1, h.slots.total);
      }).sort((a, b) => core.agentRuns(a.id).length - core.agentRuns(b.id).length);
      // Prefer an agent whose role fits; else spawn one with that role; else anyone free;
      // else spawn a worker for it (DESIGN §5f).
      const role = task.role?.toLowerCase();
      const fits = (a: { role: string }) => !!role && (a.role.toLowerCase().includes(role) || role.includes(a.role.toLowerCase()));
      const agent = candidates.find(fits)
        ?? (role && !pinned ? this.app.workers.spawnFor(task) : undefined)
        ?? candidates[0]
        ?? (!pinned ? this.app.workers.spawnFor(task) : undefined);
      if (!agent) continue;

      const run: ActiveRun = {
        id: newId("run"), taskId: task.id, agentId: agent.id, harnessId: agent.harnessId, attempt: task.attempt,
        status: "assigned", turn: 0, startedAt: nowIso(), usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
      };
      core.upsert("run", run);
      const assigned: Task = { ...task, status: "assigned", agentId: agent.id, progressNote: `Assigned to ${agent.name}`, updatedAt: nowIso() };
      core.upsert("task", assigned);
      if (!harnesses.assign(run, assigned, this.briefing(assigned, agent.id))) {
        core.upsert("run", { ...run, status: "failed", endedAt: nowIso() });
        core.upsert("task", { ...task, updatedAt: nowIso() });
        continue;
      }
      core.refreshAgent(agent.id, harnesses.isOnline);
      core.event("info", { kind: "overseer", id: "overseer" }, "run.assigned", `Assigned “${task.title}” to ${agent.name}`, { taskId: task.id, agentId: agent.id, runId: run.id });
    }
  }

  briefing(task: Task, agentId: ID): Briefing {
    const core = this.app.core;
    const team = core.teams.get(task.teamId);
    const related = [...core.tasks.values()]
      .filter((t) => t.teamId === task.teamId && t.status === "succeeded" && t.id !== task.id)
      .sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""))
      .slice(0, 3);
    const results = new Map(core.memories.filter((m) => m.source.taskId).map((m) => [m.source.taskId!, m.content]));
    return {
      goal: `${task.title}\n${task.description}`.trim(),
      dossierSummary: core.dossiers.get(agentId)?.summary ?? "",
      relatedResults: related.map((t) => ({ taskId: t.id, title: t.title, summary: (results.get(t.id) ?? "").slice(0, 500) })),
      memories: core.searchMemory(`${task.title} ${task.description}`, task.teamId, 5).map((m) => ({ id: m.id, kind: m.kind === "preference" ? "preference" : m.kind, content: m.content })),
      operatorPreferences: [
        ...(team ? [`Team ${team.name} mission: ${team.mission}`] : []),
        ...core.memories.filter((m) => m.kind === "preference" && (m.scope === "global" || m.scope === `team:${task.teamId}`)).slice(-5).map((m) => m.content),
      ],
      teammates: core.liveAgents().filter((a) => a.id !== agentId).slice(0, 20).map((a) => `${a.name} (${a.role}, ${a.status}${a.currentFocus ? `: ${a.currentFocus.slice(0, 60)}` : ""})`),
    };
  }
}
