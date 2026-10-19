import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Lightbulb, Power } from "lucide-react";
import { useStore } from "../lib/store";
import { realtime } from "../lib/realtime";
import { relativeTime, useNow } from "../lib/format";
import { StatusBadge } from "../components/StatusBadge";
import { ChatPanel } from "../components/ChatPanel";
import { Countdown } from "../components/Countdown";
import { TaskRow } from "../components/TaskRow";
import { EventFeed } from "../components/EventFeed";
import { ApprovalRoutesEditor, ToolPermissions } from "../components/Permissions";

const TABS = ["Activity", "Tasks", "Permissions", "Dossier", "Events"] as const;

function WindowBanner({ agentName, openUntil, minutes }: { agentName: string; openUntil?: string; minutes: number }) {
  const now = useNow(1000);
  const open = openUntil && new Date(openUntil).getTime() > now;
  return (
    <div className={`window-banner${open ? " open" : ""}`}>
      <Lightbulb size={14} />
      {open ? (
        <span>
          Thought window open: {agentName} can reply to you and ask questions for <Countdown until={openUntil} />. Unanswered questions go to the Overseer.
        </span>
      ) : (
        <span>
          {agentName} can't contact you right now; it asks the Overseer. Insert a thought to open a {minutes}-minute window.
        </span>
      )}
    </div>
  );
}
type Tab = (typeof TABS)[number];

export function AgentDetail() {
  const { id = "" } = useParams();
  const agent = useStore((s) => s.agents[id]);
  const harness = useStore((s) => (agent ? s.harnesses[agent.harnessId] : undefined));
  const dossier = useStore((s) => s.dossiers[id]);
  const threads = useStore((s) => s.threads);
  const tasks = useStore((s) => s.tasks);
  const events = useStore((s) => s.events);
  const thoughtWindow = useStore((s) => s.thoughtWindows[id]);
  const teams = useStore((s) => s.teams);
  const windowMinutes = useStore((s) => s.settings?.chainOfCommand.thoughtWindowMinutes ?? 15);
  const defaultRoutes = useStore((s) => s.settings?.approvals);
  const approvals = useStore((s) => s.approvals);
  const recentApprovals = useMemo(
    () => Object.values(approvals).filter((a) => a.agentId === id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 10),
    [approvals, id],
  );
  const [tab, setTab] = useState<Tab>("Activity");
  const now = useNow();

  const thread = useMemo(() => Object.values(threads).find((t) => t.kind === "overseer_agent" && t.agentId === id), [threads, id]);
  const agentTasks = useMemo(
    () => Object.values(tasks).filter((t) => t.agentId === id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [tasks, id],
  );
  const agentEvents = useMemo(() => events.filter((e) => e.agentId === id), [events, id]);

  if (!agent) {
    return (
      <div className="page">
        <div className="empty">
          Agent not found. <Link to="/agents" className="link">Back to agents</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page page-fill">
      <header className="detail-head card">
        <Link to="/agents" className="icon-btn" aria-label="Back to agents">
          <ArrowLeft size={16} />
        </Link>
        <span className="avatar lg">{agent.name.slice(0, 1)}</span>
        <div className="detail-id">
          <div className="detail-name">
            {agent.name} <StatusBadge status={agent.status} />
          </div>
          <div className="detail-role">{agent.role}</div>
          {agent.status === "retired" && <div className="muted small">Retired {relativeTime(agent.retiredAt, now)}: {agent.retireReason}</div>}
        </div>
        <dl className="detail-facts">
          <div><dt>Host</dt><dd>{harness ? <><StatusBadge status={harness.status} label={harness.name} subtle /></> : agent.harnessId}</dd></div>
          <div><dt>Spawned by</dt><dd>{agent.origin === "overseer" ? "Overseer" : "you"}</dd></div>
          <div>
            <dt>Team</dt>
            <dd>
              <select className="input input-sm" value={agent.teamId} onChange={(e) => realtime.send("agent.move", { agentId: agent.id, teamId: e.target.value })} aria-label="Team">
                {Object.values(teams).map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </dd>
          </div>
          <div><dt>Model</dt><dd className="mono">{agent.provider} · {agent.model} · {agent.effort}</dd></div>
          <div><dt>Runs</dt><dd>{agent.activeRunIds.length}/{agent.maxConcurrentRuns}</dd></div>
          <div><dt>Tools</dt><dd className="mono small">{agent.tools.join(", ")}</dd></div>
        </dl>
        {agent.status !== "retired" && (
          <button
            className="btn"
            title="Stop this agent and free its seat; its unfinished task goes back to the queue"
            onClick={() => confirm(`Retire ${agent.name}? Its current task goes back to the queue.`) && realtime.send("agent.retire", { agentId: agent.id })}
          >
            <Power size={14} /> Retire
          </button>
        )}
      </header>

      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`tab${tab === t ? " active" : ""}`} onClick={() => setTab(t)}>
            {t}
            {t === "Tasks" && <span className="chip-count">{agentTasks.length}</span>}
          </button>
        ))}
      </div>

      <div className="tab-body">
        {tab === "Activity" &&
          (thread ? (
            <section className="card chat-card">
              <header className="chat-head">
                <div>
                  <div className="chat-title">{agent.name} ↔ Overseer</div>
                  <div className="chat-subtitle">The agent's thread: Overseer messages, your thoughts, and its replies</div>
                </div>
              </header>
              <ChatPanel
                threadId={thread.id}
                placeholder={`Insert a thought into ${agent.name}… (delivered at its next turn boundary)`}
                sendLabel={<><Lightbulb size={15} /> Insert</>}
                banner={<WindowBanner agentName={agent.name} openUntil={thoughtWindow?.openUntil} minutes={windowMinutes} />}
                onSend={(content, answersMessageId) =>
                  realtime.send("thought.insert", { agentId: agent.id, content, ...(answersMessageId ? { answersMessageId } : {}) })
                }
              />
            </section>
          ) : (
            <div className="card pad empty">This agent has no thread yet; it's created when the agent first connects.</div>
          ))}

        {tab === "Tasks" && (
          <div className="card list-card">
            {agentTasks.length === 0 ? <div className="empty">No tasks yet.</div> : agentTasks.map((t) => <TaskRow key={t.id} task={t} />)}
          </div>
        )}

        {tab === "Permissions" && (
          <div className="card pad settings-section">
            {agent.status === "retired" ? (
              <div className="empty">Retired agents have no permissions to change.</div>
            ) : (
              <>
                <h3 className="section-title">Tools</h3>
                <p className="muted small">“ask” sends each call for approval; the risk picks who approves it. Changes apply to running tasks at once.</p>
                <ToolPermissions grants={agent.toolGrants} onChange={(tools) => realtime.send("agent.update", { agentId: agent.id, tools })} />
                <h3 className="section-title">Who approves</h3>
                {defaultRoutes && (
                  <ApprovalRoutesEditor routes={agent.approvals ?? {}} defaults={defaultRoutes} onChange={(r) => realtime.send("agent.update", { agentId: agent.id, approvals: r })} />
                )}
              </>
            )}
            <h3 className="section-title">Recent approvals</h3>
            {recentApprovals.length === 0 ? (
              <div className="muted small">None yet.</div>
            ) : (
              <ul className="approval-log">
                {recentApprovals.map((a) => (
                  <li key={a.id}>
                    <StatusBadge status={a.status === "approved" ? "succeeded" : a.status === "denied" ? "failed" : "waiting"} label={a.status === "pending" ? `waiting on ${a.stage ?? "you"}` : `${a.status} by ${a.decidedBy === "operator" ? "you" : a.decidedBy ?? "you"}`} />
                    <code className="mono small">{a.toolName} {JSON.stringify(a.input).slice(0, 120)}</code>
                    <span className="muted small">{a.note ?? a.reviewNotes?.at(-1) ?? ""}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {tab === "Dossier" && (
          <div className="card pad dossier">
            {dossier ? (
              <>
                <div className="dossier-meta muted">
                  Version {dossier.version} · updated {relativeTime(dossier.updatedAt, now)} · maintained by the Overseer
                </div>
                <h3 className="section-title">Summary</h3>
                <p>{dossier.summary || "—"}</p>
                <h3 className="section-title">Current focus</h3>
                <p>{dossier.currentFocus || "—"}</p>
                <div className="dossier-cols">
                  <div>
                    <h3 className="section-title">Known facts</h3>
                    {dossier.knownFacts.length ? <ul className="bullets">{dossier.knownFacts.map((f) => <li key={f}>{f}</li>)}</ul> : <p className="muted">None recorded.</p>}
                  </div>
                  <div>
                    <h3 className="section-title">Open questions</h3>
                    {dossier.openQuestions.length ? <ul className="bullets">{dossier.openQuestions.map((q) => <li key={q}>{q}</li>)}</ul> : <p className="muted">None.</p>}
                  </div>
                </div>
              </>
            ) : (
              <div className="empty">No dossier yet.</div>
            )}
          </div>
        )}

        {tab === "Events" && (
          <div className="card feed-card">
            <EventFeed events={agentEvents} limit={200} />
          </div>
        )}
      </div>
    </div>
  );
}
