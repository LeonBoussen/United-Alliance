import { NavLink } from "react-router-dom";
import { Activity, Bot, Crown, LayoutDashboard, LifeBuoy, ListChecks, MessagesSquare, Server, Settings as SettingsIcon, Users } from "lucide-react";
import { store, useStore } from "../lib/store";
import { useNeedsYou } from "../lib/needs-you";
import { TeamDot } from "../lib/teams";
import { StatusBadge } from "./StatusBadge";

const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/overseer", label: "Overseer", icon: Crown },
  { to: "/helper", label: "Helper", icon: LifeBuoy },
  { to: "/board", label: "Board", icon: MessagesSquare },
  { to: "/teams", label: "Teams", icon: Users },
  { to: "/agents", label: "Agents", icon: Bot },
  { to: "/hosts", label: "Hosts", icon: Server },
  { to: "/tasks", label: "Tasks", icon: ListChecks },
  { to: "/monitoring", label: "Monitoring", icon: Activity },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
];

function TeamSwitcher() {
  const teams = useStore((s) => s.teams);
  const teamFilter = useStore((s) => s.teamFilter);
  const current = teamFilter === "all" ? undefined : teams[teamFilter];
  return (
    <label className="team-switcher" title="Scope the console to one team">
      <TeamDot team={current} />
      <select value={teamFilter} onChange={(e) => store.setTeamFilter(e.target.value)} aria-label="Team">
        <option value="all">All teams</option>
        {Object.values(teams).map((t) => (
          <option key={t.id} value={t.id}>{t.name}</option>
        ))}
      </select>
    </label>
  );
}

export function Sidebar() {
  const connection = useStore((s) => s.connection);
  const needs = useNeedsYou();
  const pending = needs.length;
  // Escalations from the helper are answered on the Helper page.
  const helperPending = needs.filter((n) => n.kind === "escalation" && n.message.role === "helper").length;

  return (
    <aside className="sidebar">
      <div className="brand">
        <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden>
          <path d="M16 2 30 16 16 30 2 16z" fill="var(--accent)" />
          <path d="M16 9 23 16 16 23 9 16z" fill="var(--bg)" />
        </svg>
        <span className="brand-name">United Alliance</span>
      </div>

      <TeamSwitcher />

      <nav className="nav">
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}>
            <Icon size={17} strokeWidth={1.8} />
            <span className="nav-label">{label}</span>
            {to === "/overseer" && pending > 0 && <span className="nav-count" title={`${pending} waiting on you`}>{pending}</span>}
            {to === "/helper" && helperPending > 0 && <span className="nav-count" title={`${helperPending} question(s) from the helper`}>{helperPending}</span>}
          </NavLink>
        ))}
      </nav>

      <div className="sidebar-foot">
        <StatusBadge status={connection} label={connection === "mock" ? "Mock backend" : connection} subtle />
      </div>
    </aside>
  );
}
