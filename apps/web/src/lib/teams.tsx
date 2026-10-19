import { useMemo } from "react";
import type { ID, Team } from "@alliance/protocol";
import { useStore } from "./store";

export interface TeamScope {
  /** "all" or the selected team id. */
  teamId: ID | "all";
  team?: Team;
  agentInScope: (agentId: ID | undefined) => boolean;
  teamInScope: (teamId: ID | undefined) => boolean;
}

/** The sidebar's team switcher scopes every page through this hook. */
export function useTeamScope(): TeamScope {
  const teamId = useStore((s) => s.teamFilter);
  const teams = useStore((s) => s.teams);
  const agents = useStore((s) => s.agents);
  return useMemo(() => {
    if (teamId === "all") return { teamId, agentInScope: () => true, teamInScope: () => true };
    return {
      teamId,
      team: teams[teamId],
      agentInScope: (id) => !!id && agents[id]?.teamId === teamId,
      teamInScope: (id) => id === teamId,
    };
  }, [teamId, teams, agents]);
}

export function TeamDot({ team }: { team?: Team }) {
  return <span className="team-dot" style={{ background: team?.color ?? "var(--muted)" }} aria-hidden />;
}

export function TeamChip({ team }: { team?: Team }) {
  if (!team) return null;
  return (
    <span className="team-chip">
      <TeamDot team={team} />
      {team.name}
    </span>
  );
}
