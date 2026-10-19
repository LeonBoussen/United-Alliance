import { useMemo } from "react";
import { Link } from "react-router-dom";
import { ACTIVE_TASK_STATUSES } from "@alliance/protocol";
import { useStore } from "../lib/store";
import { useTeamScope } from "../lib/teams";
import { num, pct, usd } from "../lib/format";
import { StatCard } from "../components/StatCard";
import { AgentCard } from "../components/AgentCard";
import { TaskRow } from "../components/TaskRow";
import { EventFeed } from "../components/EventFeed";

export function Overview() {
  const agents = useStore((s) => s.agents);
  const tasks = useStore((s) => s.tasks);
  const events = useStore((s) => s.events);
  const metrics = useStore((s) => s.metrics);
  const m = metrics.at(-1);

  const scope = useTeamScope();
  const agentList = useMemo(() => Object.values(agents).filter((a) => a.status !== "retired" && scope.agentInScope(a.id)), [agents, scope]);
  const activeTasks = useMemo(
    () => Object.values(tasks).filter((t) => scope.teamInScope(t.teamId) && ACTIVE_TASK_STATUSES.includes(t.status)),
    [tasks, scope],
  );
  const scopedEvents = useMemo(
    () =>
      scope.teamId === "all"
        ? events
        : events.filter((e) => (e.agentId ? scope.agentInScope(e.agentId) : e.taskId ? scope.teamInScope(tasks[e.taskId]?.teamId) : true)),
    [events, tasks, scope],
  );
  const tokenTrend = useMemo(() => metrics.slice(-40).map((x) => x.tokensPerMin), [metrics]);

  return (
    <div className="page">
      <section className="stats-row">
        <StatCard label="Agents online" value={m ? `${m.agentsOnline}/${m.agentsTotal}` : "—"} hint="across all hosts" />
        <StatCard label="Active runs" value={m?.runsActive ?? "—"} hint="running or waiting" />
        <StatCard label="Queued tasks" value={m?.tasksQueued ?? "—"} hint="waiting for a slot" />
        <StatCard label="Tokens / min" value={m ? num(m.tokensPerMin) : "—"} trend={tokenTrend} />
        <StatCard label="Cost today" value={m ? usd(m.costTodayUsd) : "—"} hint="via model gateway" />
        <StatCard label="Error rate" value={m ? pct(m.errorRate) : "—"} hint="last 5 minutes" />
      </section>

      <div className="split">
        <div className="stack">
          <section className="panel">
            <header className="panel-head">
              <h2>Agents{scope.team ? ` · ${scope.team.name}` : ""}</h2>
              <Link to="/hosts" className="link">+ Add host</Link>
            </header>
            <div className="agent-grid">
              {agentList.map((a) => (
                <AgentCard key={a.id} agent={a} />
              ))}
            </div>
          </section>

          <section className="panel">
            <header className="panel-head">
              <h2>Active tasks</h2>
              <Link to="/tasks" className="link">Task board →</Link>
            </header>
            <div className="card list-card">
              {activeTasks.length === 0 ? (
                <div className="empty">Nothing running.</div>
              ) : (
                activeTasks.map((t) => <TaskRow key={t.id} task={t} compact />)
              )}
            </div>
          </section>
        </div>

        <section className="panel">
          <header className="panel-head">
            <h2>Live events</h2>
            <Link to="/monitoring" className="link">Event log →</Link>
          </header>
          <div className="card feed-card">
            <EventFeed events={scopedEvents} limit={40} dense />
          </div>
        </section>
      </div>
    </div>
  );
}
