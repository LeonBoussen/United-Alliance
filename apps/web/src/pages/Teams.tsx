import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Plus, UserPlus } from "lucide-react";
import { ACTIVE_TASK_STATUSES, type Team } from "@alliance/protocol";
import { useStore, store } from "../lib/store";
import { realtime } from "../lib/realtime";
import { num } from "../lib/format";
import { TeamDot } from "../lib/teams";
import { StatusBadge } from "../components/StatusBadge";
import { ProgressBar } from "../components/TaskRow";

const COLORS = ["#7c8cff", "#3ecf8e", "#f2b84b", "#f2667a", "#5ab0f2", "#c17cff", "#ff9f5a"];

function TeamForm({ team, onDone }: { team?: Team; onDone: () => void }) {
  const [name, setName] = useState(team?.name ?? "");
  const [mission, setMission] = useState(team?.mission ?? "");
  const [color, setColor] = useState(team?.color ?? COLORS[Math.floor(Math.random() * COLORS.length)]!);
  const [lead, setLead] = useState(team?.leadInstructions ?? "");
  const [tokens, setTokens] = useState(team?.budget?.dailyTokens ? String(team.budget.dailyTokens) : "");

  return (
    <form
      className="team-form"
      onSubmit={(e) => {
        e.preventDefault();
        const draft = {
          name: name.trim(), mission: mission.trim(), color,
          ...(lead.trim() ? { leadInstructions: lead.trim() } : {}),
          ...(Number(tokens) > 0 ? { budget: { dailyTokens: Number(tokens) } } : {}),
        };
        if (team) realtime.send("team.update", { teamId: team.id, patch: draft });
        else realtime.send("team.create", draft);
        onDone();
      }}
    >
      <div className="provider-grid">
        <label className="field">
          <span>Name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={40} autoFocus={!team} />
        </label>
        <div className="field">
          <span>Colour</span>
          <div className="swatches">
            {COLORS.map((c) => (
              <button type="button" key={c} className={`swatch${c === color ? " active" : ""}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={`Colour ${c}`} />
            ))}
          </div>
        </div>
        <label className="field full">
          <span>Mission</span>
          <textarea className="input" rows={2} value={mission} onChange={(e) => setMission(e.target.value)} required placeholder="The standing goal the Overseer keeps in mind for this team" />
        </label>
        <label className="field full">
          <span>Overseer instructions for this team (optional)</span>
          <textarea className="input" rows={2} value={lead} onChange={(e) => setLead(e.target.value)} placeholder="How the Overseer should lead this team, what to escalate…" />
        </label>
        <label className="field">
          <span>Daily token budget (optional)</span>
          <input className="input" type="number" min={0} step={100000} value={tokens} onChange={(e) => setTokens(e.target.value)} />
        </label>
      </div>
      <div className="form-actions">
        <button type="button" className="btn" onClick={onDone}>Cancel</button>
        <button className="btn btn-primary" disabled={!name.trim() || !mission.trim()}>{team ? "Save" : "Create team"}</button>
      </div>
    </form>
  );
}

export function Teams() {
  const teams = useStore((s) => s.teams);
  const agents = useStore((s) => s.agents);
  const tasks = useStore((s) => s.tasks);
  const teamFilter = useStore((s) => s.teamFilter);
  const teamList = useMemo(() => Object.values(teams), [teams]);
  const [selected, setSelected] = useState<string | undefined>(teamFilter !== "all" ? teamFilter : undefined);
  const [mode, setMode] = useState<"view" | "edit" | "create">("view");

  useEffect(() => {
    if (!selected && teamList[0]) setSelected(teamList[0].id);
  }, [selected, teamList]);

  const team = selected ? teams[selected] : undefined;
  const members = Object.values(agents).filter((a) => a.teamId === selected && a.status !== "retired");
  const teamTasks = Object.values(tasks).filter((t) => t.teamId === selected);
  const active = teamTasks.filter((t) => ACTIVE_TASK_STATUSES.includes(t.status)).length;
  const usedTokens = teamTasks.reduce((n, t) => n + t.usedTokens, 0);

  return (
    <div className="page page-fill teams-layout">
      <aside className="card thread-list">
        <header className="panel-head">
          <h2>Teams</h2>
          <button className="icon-btn" title="New team" aria-label="New team" onClick={() => setMode("create")}>
            <Plus size={16} />
          </button>
        </header>
        <ul>
          {teamList.map((t) => (
            <li key={t.id}>
              <button className={`thread-item${t.id === selected && mode !== "create" ? " active" : ""}`} onClick={() => { setSelected(t.id); setMode("view"); }}>
                <span className="thread-title"><TeamDot team={t} /> {t.name}</span>
                <span className="thread-time">{Object.values(agents).filter((a) => a.teamId === t.id && a.status !== "retired").length} agents</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <div className="stack team-detail">
        {mode === "create" ? (
          <section className="card pad settings-section">
            <h2 className="wizard-title">New team</h2>
            <TeamForm onDone={() => setMode("view")} />
          </section>
        ) : team ? (
          <>
            <section className="card pad settings-section">
              <header className="team-head">
                <span className="team-swatch" style={{ background: team.color }} />
                <div className="grow">
                  <h2 className="wizard-title">{team.name}</h2>
                  {mode === "view" && <p className="muted">{team.mission}</p>}
                </div>
                {mode === "view" && (
                  <>
                    <button className="btn" onClick={() => store.setTeamFilter(team.id)} disabled={teamFilter === team.id}>
                      {teamFilter === team.id ? "Console scoped to this team" : "Scope console to this team"}
                    </button>
                    <button className="btn" onClick={() => setMode("edit")}>Edit</button>
                  </>
                )}
              </header>
              {mode === "edit" ? (
                <TeamForm team={team} onDone={() => setMode("view")} />
              ) : (
                <>
                  {team.leadInstructions && (
                    <div className="notice">Overseer instructions: {team.leadInstructions}</div>
                  )}
                  <div className="team-stats">
                    <div><span className="stat-label">Agents</span><b>{members.length}</b></div>
                    <div><span className="stat-label">Active tasks</span><b>{active}</b></div>
                    <div><span className="stat-label">Tokens used</span><b>{num(usedTokens)}</b></div>
                    {team.budget?.dailyTokens && (
                      <div className="grow">
                        <span className="stat-label">Daily budget {num(team.budget.dailyTokens)}</span>
                        <ProgressBar value={usedTokens / team.budget.dailyTokens} tone={usedTokens / team.budget.dailyTokens > 0.9 ? "bad" : "good"} />
                      </div>
                    )}
                  </div>
                </>
              )}
            </section>

            <section className="card pad settings-section">
              <header className="panel-head">
                <h3 className="section-title">Members</h3>
                <Link to="/agents" className="btn"><UserPlus size={14} /> Spawn agent</Link>
              </header>
              {members.length === 0 ? (
                <div className="empty small">No agents right now. The Overseer spawns members on your hosts when this team has work.</div>
              ) : (
                <table className="table">
                  <thead>
                    <tr><th>Agent</th><th>Status</th><th>Model</th><th>Focus</th><th>Team</th></tr>
                  </thead>
                  <tbody>
                    {members.map((a) => (
                      <tr key={a.id}>
                        <td><Link to={`/agents/${a.id}`} className="link-plain"><b>{a.name}</b></Link></td>
                        <td><StatusBadge status={a.status} /></td>
                        <td className="mono small">{a.model}</td>
                        <td className="muted small ellipsis">{a.currentFocus}</td>
                        <td>
                          <select className="input input-sm" value={a.teamId} onChange={(e) => realtime.send("agent.move", { agentId: a.id, teamId: e.target.value })} aria-label={`Move ${a.name} to team`}>
                            {teamList.map((t) => (
                              <option key={t.id} value={t.id}>{t.name}</option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </>
        ) : (
          <div className="card pad empty">Create your first team.</div>
        )}
      </div>
    </div>
  );
}
