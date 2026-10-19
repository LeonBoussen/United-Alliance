import { Link } from "react-router-dom";
import type { Agent } from "@alliance/protocol";
import { useStore } from "../lib/store";
import { TeamChip } from "../lib/teams";
import { StatusBadge } from "./StatusBadge";

export function AgentCard({ agent }: { agent: Agent }) {
  const harness = useStore((s) => s.harnesses[agent.harnessId]);
  const team = useStore((s) => s.teams[agent.teamId]);
  return (
    <Link to={`/agents/${agent.id}`} className="card agent-card">
      <div className="agent-card-head">
        <span className="avatar">{agent.name.slice(0, 1)}</span>
        <div className="agent-card-id">
          <div className="agent-card-name">{agent.name}</div>
          <div className="agent-card-role">{agent.role}</div>
        </div>
        <StatusBadge status={agent.status} />
      </div>
      <p className="agent-card-focus">{agent.currentFocus ?? "—"}</p>
      <div className="agent-card-meta">
        <TeamChip team={team} />
        <span title="Host">{harness?.name ?? (agent.harnessId || "no host")}</span>
        <span>·</span>
        <span>{agent.activeRunIds.length}/{agent.maxConcurrentRuns} runs</span>
        <span>·</span>
        <span className="mono">{agent.model}</span>
      </div>
    </Link>
  );
}
