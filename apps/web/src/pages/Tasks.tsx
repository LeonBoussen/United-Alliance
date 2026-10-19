import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import type { TaskPriority, TaskStatus } from "@alliance/protocol";
import { useStore } from "../lib/store";
import { realtime } from "../lib/realtime";
import { useTeamScope } from "../lib/teams";
import { TaskRow } from "../components/TaskRow";

const GROUPS: Record<string, TaskStatus[] | null> = {
  All: null,
  Active: ["assigned", "running"],
  Queued: ["queued"],
  "Needs you": ["waiting_approval", "paused"],
  Done: ["succeeded"],
  Failed: ["failed", "cancelled"],
};

const PRIORITY_ORDER: Record<TaskPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

export function Tasks() {
  const tasks = useStore((s) => s.tasks);
  const agents = useStore((s) => s.agents);
  const [group, setGroup] = useState("All");
  const [creating, setCreating] = useState(false);

  const teams = useStore((s) => s.teams);
  const scope = useTeamScope();
  const all = useMemo(() => Object.values(tasks).filter((t) => scope.teamInScope(t.teamId)), [tasks, scope]);
  const list = useMemo(() => {
    const statuses = GROUPS[group];
    return all
      .filter((t) => !statuses || statuses.includes(t.status))
      .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || b.updatedAt.localeCompare(a.updatedAt));
  }, [all, group]);

  return (
    <div className="page">
      <div className="toolbar">
        <div className="chips" role="tablist">
          {Object.entries(GROUPS).map(([name, statuses]) => (
            <button key={name} role="tab" aria-selected={group === name} className={`chip${group === name ? " active" : ""}`} onClick={() => setGroup(name)}>
              {name}
              <span className="chip-count">{statuses ? all.filter((t) => statuses.includes(t.status)).length : all.length}</span>
            </button>
          ))}
        </div>
        <button className="btn btn-primary" onClick={() => setCreating((c) => !c)}>
          <Plus size={14} /> New task
        </button>
      </div>

      {creating && (
        <form
          className="card pad task-form"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const agentId = String(f.get("agentId") || "");
            const budget = Number(f.get("budget") || 0);
            const teamId = String(f.get("teamId") || "");
            realtime.send("task.create", {
              teamId: agentId ? (agents[agentId]?.teamId ?? teamId) : teamId,
              title: String(f.get("title")),
              description: String(f.get("description") || ""),
              priority: String(f.get("priority")) as TaskPriority,
              ...(agentId ? { agentId } : {}),
              ...(budget ? { budgetTokens: budget } : {}),
            });
            setCreating(false);
          }}
        >
          <label className="field grow">
            <span>Title</span>
            <input className="input" name="title" required placeholder="What should be done?" autoFocus />
          </label>
          <label className="field full">
            <span>Description & acceptance criteria</span>
            <textarea className="input" name="description" rows={3} placeholder="Context, constraints, and how we know it's done" />
          </label>
          <label className="field">
            <span>Priority</span>
            <select className="input" name="priority" defaultValue="normal">
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </label>
          <label className="field">
            <span>Team</span>
            <select className="input" name="teamId" defaultValue={scope.team?.id ?? Object.keys(teams)[0]} required>
              {Object.values(teams).map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Agent</span>
            <select className="input" name="agentId" defaultValue="">
              <option value="">Let the Overseer decide</option>
              {Object.values(agents).filter((a) => a.status !== "retired" && scope.agentInScope(a.id)).map((a) => (
                <option key={a.id} value={a.id}>{a.name} ({teams[a.teamId]?.name})</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Token budget</span>
            <input className="input" name="budget" type="number" min={20000} step={10000} placeholder="e.g. 200000" />
          </label>
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => setCreating(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary">Create task</button>
          </div>
        </form>
      )}

      <div className="card list-card task-table">
        <div className="task-row head">
          <span>Task</span>
          <span>Status</span>
          <span>Progress</span>
          <span>Tokens</span>
          <span>Runtime</span>
          <span />
        </div>
        {list.length === 0 ? <div className="empty">No tasks here.</div> : list.map((t) => <TaskRow key={t.id} task={t} />)}
      </div>
    </div>
  );
}
