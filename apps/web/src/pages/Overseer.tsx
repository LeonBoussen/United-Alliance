import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Plus } from "lucide-react";
import { useStore } from "../lib/store";
import { realtime } from "../lib/realtime";
import { relativeTime, useNow } from "../lib/format";
import { ChatPanel } from "../components/ChatPanel";
import { NeedsYou } from "../components/NeedsYou";
import { Dot } from "../components/StatusBadge";
import { TeamDot, useTeamScope } from "../lib/teams";

export function Overseer() {
  const threads = useStore((s) => s.threads);
  const agents = useStore((s) => s.agents);
  const now = useNow();

  const teams = useStore((s) => s.teams);
  const scope = useTeamScope();
  // Scoped to a team: that team's threads plus fleet-wide ones (no team).
  const overseerThreads = useMemo(
    () =>
      Object.values(threads)
        .filter((t) => t.kind === "operator_overseer" && (!t.teamId || scope.teamInScope(t.teamId)))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [threads, scope],
  );
  const [selected, setSelected] = useState<string | undefined>();

  useEffect(() => {
    if ((!selected || !overseerThreads.some((t) => t.id === selected)) && overseerThreads[0]) setSelected(overseerThreads[0].id);
  }, [selected, overseerThreads]);

  const current = selected ? threads[selected] : undefined;

  return (
    <div className="page page-fill three-col">
      <aside className="card thread-list">
        <header className="panel-head">
          <h2>Conversations</h2>
          <button
            className="icon-btn"
            title="New conversation"
            aria-label="New conversation"
            onClick={() =>
              realtime.send("thread.create", {
                kind: "operator_overseer",
                title: scope.team ? `New ${scope.team.name} conversation` : "New fleet conversation",
                ...(scope.team ? { teamId: scope.team.id } : {}),
              })
            }
          >
            <Plus size={16} />
          </button>
        </header>
        <ul>
          {overseerThreads.map((t) => (
            <li key={t.id}>
              <button className={`thread-item${t.id === selected ? " active" : ""}`} onClick={() => setSelected(t.id)}>
                <span className="thread-title">
                  <TeamDot team={t.teamId ? teams[t.teamId] : undefined} /> {t.title}
                </span>
                <span className="thread-time">{relativeTime(t.updatedAt, now)}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="card chat-card">
        <header className="chat-head">
          <span className="avatar overseer">O</span>
          <div>
            <div className="chat-title">{current?.title ?? "Overseer"}</div>
            <div className="chat-subtitle">
              {current?.teamId ? `Overseer · leading ${teams[current.teamId]?.name ?? "team"} · team context only` : "Overseer · fleet-wide · sees team summaries"} · spawns agents as needed · asks its helper when stuck
            </div>
          </div>
        </header>
        {current ? (
          <ChatPanel
            threadId={current.id}
            placeholder="Ask the Overseer to plan, delegate or report…"
            onSend={(content, answersMessageId) =>
              realtime.send("message.send", { threadId: current.id, content, ...(answersMessageId ? { answersMessageId } : {}) })
            }
          />
        ) : (
          <div className="empty">Select a conversation.</div>
        )}
      </section>

      <aside className="stack context-col">
        <NeedsYou />

        <section className="card pad">
          <h3 className="section-title">Fleet context</h3>
          <ul className="context-list">
            {Object.values(agents).filter((a) => a.status !== "retired" && (current?.teamId ? a.teamId === current.teamId : scope.agentInScope(a.id))).map((a) => (
              <li key={a.id}>
                <Link to={`/agents/${a.id}`} className="context-item">
                  <Dot status={a.status} />
                  <div>
                    <div className="context-name">
                      {a.name} <span className="muted">· {a.status}</span>
                    </div>
                    <div className="context-focus">{a.currentFocus}</div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </aside>
    </div>
  );
}
