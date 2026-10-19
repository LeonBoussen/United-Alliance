import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Server, UserPlus } from "lucide-react";
import type { AgentStatus } from "@alliance/protocol";
import { useStore } from "../lib/store";
import { realtime } from "../lib/realtime";
import { useTeamScope } from "../lib/teams";
import { AgentCard } from "../components/AgentCard";

const FILTERS: (AgentStatus | "all")[] = ["all", "busy", "idle", "waiting", "error", "offline", "retired"];

function SpawnForm({ onDone }: { onDone: () => void }) {
  const teams = useStore((s) => s.teams);
  const harnesses = useStore((s) => s.harnesses);
  const scope = useTeamScope();
  const teamList = useMemo(() => Object.values(teams), [teams]);
  const online = useMemo(() => Object.values(harnesses).filter((h) => h.status !== "offline"), [harnesses]);
  const [teamId, setTeamId] = useState(scope.team?.id ?? teamList[0]?.id ?? "");
  const [role, setRole] = useState("");
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [harnessId, setHarnessId] = useState("");

  return (
    <form
      className="card pad settings-section"
      onSubmit={(e) => {
        e.preventDefault();
        realtime.send("agent.spawn", {
          teamId: teamId || teamList[0]?.id || "", role: role.trim(),
          ...(name.trim() ? { name: name.trim() } : {}), ...(instructions.trim() ? { instructions: instructions.trim() } : {}), ...(harnessId ? { harnessId } : {}),
        });
        onDone();
      }}
    >
      <h2 className="wizard-title">Spawn an agent</h2>
      <p className="muted">Usually the Overseer does this when work needs it. Agents you spawn stay until you retire them.</p>
      {online.length === 0 && (
        <div className="notice">
          <Server size={14} /> No host is online. <Link to="/hosts" className="link">Add a host</Link> and run it on a machine first.
        </div>
      )}
      <div className="provider-grid">
        <label className="field full">
          <span>Role</span>
          <input className="input" value={role} onChange={(e) => setRole(e.target.value)} placeholder="e.g. Tester: runs suites and triages failures" required />
        </label>
        <label className="field">
          <span>Team</span>
          <select className="input" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
            {teamList.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Host</span>
          <select className="input" value={harnessId} onChange={(e) => setHarnessId(e.target.value)}>
            <option value="">Most free seats</option>
            {online.map((h) => (
              <option key={h.id} value={h.id}>{h.name}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Name (optional)</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={24} placeholder="picked for you" />
        </label>
        <label className="field full">
          <span>Instructions (optional)</span>
          <textarea className="input" rows={2} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="How this agent should work, what to avoid…" />
        </label>
      </div>
      <div className="form-actions">
        <button type="button" className="btn" onClick={onDone}>Cancel</button>
        <button className="btn btn-primary" disabled={!role.trim() || online.length === 0}>Spawn</button>
      </div>
    </form>
  );
}

export function Agents() {
  const agents = useStore((s) => s.agents);
  const scope = useTeamScope();
  const [filter, setFilter] = useState<AgentStatus | "all">("all");
  const [query, setQuery] = useState("");
  const [spawning, setSpawning] = useState(false);

  const inTeam = useMemo(() => Object.values(agents).filter((a) => scope.agentInScope(a.id)), [agents, scope]);
  const count = (f: AgentStatus | "all") => inTeam.filter((a) => (f === "all" ? a.status !== "retired" : a.status === f)).length;
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return inTeam
      .filter((a) => (filter === "all" ? a.status !== "retired" : a.status === filter))
      .filter((a) => !q || `${a.name} ${a.role} ${a.currentFocus ?? ""}`.toLowerCase().includes(q))
      .sort((a, b) => (b.retiredAt ?? b.createdAt ?? "").localeCompare(a.retiredAt ?? a.createdAt ?? ""));
  }, [inTeam, filter, query]);

  return (
    <div className="page">
      {spawning && <SpawnForm onDone={() => setSpawning(false)} />}
      <div className="toolbar">
        <div className="chips" role="tablist">
          {FILTERS.map((f) => (
            <button key={f} role="tab" aria-selected={filter === f} className={`chip${filter === f ? " active" : ""}`} onClick={() => setFilter(f)}>
              {f}
              <span className="chip-count">{count(f)}</span>
            </button>
          ))}
        </div>
        <div className="toolbar tight">
          <input className="input search" placeholder="Search agents…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className="btn btn-primary" onClick={() => setSpawning(true)} disabled={spawning}>
            <UserPlus size={14} /> Spawn agent
          </button>
        </div>
      </div>
      <div className="agent-grid wide">
        {list.map((a) => (
          <AgentCard key={a.id} agent={a} />
        ))}
        {list.length === 0 && (
          <div className="empty">
            {filter === "all" && inTeam.length === 0
              ? <>No agents yet. Give the Overseer a task and it spawns the agents it needs on your <Link to="/hosts" className="link">hosts</Link>.</>
              : "No agents match."}
          </div>
        )}
      </div>
    </div>
  );
}
