import { useSyncExternalStore } from "react";
import type {
  Agent,
  BoardPost,
  BoardThread,
  HarnessBuild,
  HelperGuidance,
  Team,
  Approval,
  Dossier,
  Harness,
  ID,
  Message,
  MetricsSnapshot,
  OverseerToUi,
  ServerSettings,
  SystemEvent,
  Task,
  ThoughtWindow,
  Thread,
} from "@alliance/protocol";

export type ConnectionState = "connecting" | "live" | "offline" | "mock";

export interface State {
  connection: ConnectionState;
  harnesses: Record<ID, Harness>;
  agents: Record<ID, Agent>;
  threads: Record<ID, Thread>;
  /** Messages grouped by thread id, oldest first. */
  messages: Record<ID, Message[]>;
  tasks: Record<ID, Task>;
  dossiers: Record<ID, Dossier>;
  approvals: Record<ID, Approval>;
  /** Newest first, capped at MAX_EVENTS. */
  events: SystemEvent[];
  /** Oldest first, capped at MAX_METRICS. */
  metrics: MetricsSnapshot[];
  settings?: ServerSettings;
  /** Open thought windows by agent id. */
  thoughtWindows: Record<ID, ThoughtWindow>;
  teams: Record<ID, Team>;
  builds: Record<ID, HarnessBuild>;
  boardThreads: Record<ID, BoardThread>;
  /** Board posts grouped by thread id, oldest first. */
  boardPosts: Record<ID, BoardPost[]>;
  guidance: Record<ID, HelperGuidance>;
  /** Console-only: which team every page is scoped to ("all" = whole fleet). */
  teamFilter: ID | "all";
  lastSeq: number;
}

const MAX_EVENTS = 500;
const MAX_METRICS = 120;

let state: State = {
  connection: "connecting",
  harnesses: {},
  agents: {},
  threads: {},
  messages: {},
  tasks: {},
  dossiers: {},
  approvals: {},
  events: [],
  metrics: [],
  thoughtWindows: {},
  teams: {},
  builds: {},
  boardThreads: {},
  boardPosts: {},
  guidance: {},
  teamFilter: readTeamFilter(),
  lastSeq: 0,
};

function readTeamFilter(): ID | "all" {
  try {
    return localStorage.getItem("ua-team") || "all";
  } catch {
    return "all";
  }
}

const listeners = new Set<() => void>();

function setState(next: State) {
  state = next;
  for (const l of listeners) l();
}

function byId<T extends { id: ID }>(items: T[]): Record<ID, T> {
  return Object.fromEntries(items.map((i) => [i.id, i]));
}

function upsertMessage(list: Message[] | undefined, msg: Message): Message[] {
  const current = list ?? [];
  const idx = current.findIndex((m) => m.id === msg.id);
  if (idx === -1) return [...current, msg];
  const copy = current.slice();
  copy[idx] = msg;
  return copy;
}

export const store = {
  getState: () => state,

  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  setTeamFilter(teamFilter: ID | "all") {
    try {
      localStorage.setItem("ua-team", teamFilter);
    } catch {
      /* storage unavailable */
    }
    setState({ ...state, teamFilter });
  },

  setConnection(connection: ConnectionState) {
    if (state.connection !== connection) setState({ ...state, connection });
  },

  /** Apply one message from the overseer (or the mock backend). */
  apply(msg: OverseerToUi) {
    switch (msg.type) {
      case "snapshot": {
        const s = msg.payload;
        const messages: Record<ID, Message[]> = {};
        for (const m of s.messages) (messages[m.threadId] ??= []).push(m);
        const events = [...s.events].sort((a, b) => b.seq - a.seq).slice(0, MAX_EVENTS);
        const boardPosts: Record<ID, BoardPost[]> = {};
        for (const p of [...s.boardPosts].sort((a, b) => a.no - b.no)) (boardPosts[p.threadId] ??= []).push(p);
        setState({
          ...state,
          harnesses: byId(s.harnesses),
          agents: byId(s.agents),
          threads: byId(s.threads),
          messages,
          tasks: byId(s.tasks),
          dossiers: Object.fromEntries(s.dossiers.map((d) => [d.agentId, d])),
          approvals: byId(s.approvals),
          events,
          metrics: s.metrics.slice(-MAX_METRICS),
          settings: s.settings,
          thoughtWindows: Object.fromEntries(s.thoughtWindows.map((w) => [w.agentId, w])),
          teams: byId(s.teams),
          builds: byId(s.builds),
          boardThreads: byId(s.boardThreads),
          boardPosts,
          guidance: byId(s.guidance),
          // Drop a remembered team that no longer exists.
          teamFilter: state.teamFilter === "all" || s.teams.some((t) => t.id === state.teamFilter) ? state.teamFilter : "all",
          // The snapshot is authoritative: an Overseer whose data was removed counts from 1 again.
          lastSeq: events[0]?.seq ?? 0,
        });
        return;
      }
      case "event": {
        const e = msg.payload;
        if (e.seq <= state.lastSeq) return; // replayed duplicate
        setState({ ...state, events: [e, ...state.events].slice(0, MAX_EVENTS), lastSeq: e.seq });
        return;
      }
      case "message": {
        const m = msg.payload;
        setState({ ...state, messages: { ...state.messages, [m.threadId]: upsertMessage(state.messages[m.threadId], m) } });
        return;
      }
      case "board.post": {
        const p = msg.payload;
        const list = state.boardPosts[p.threadId] ?? [];
        if (list.some((x) => x.id === p.id)) return;
        setState({ ...state, boardPosts: { ...state.boardPosts, [p.threadId]: [...list, p] } });
        return;
      }
      case "metrics":
        setState({ ...state, metrics: [...state.metrics, msg.payload].slice(-MAX_METRICS) });
        return;
      case "entity": {
        const u = msg.payload;
        switch (u.kind) {
          case "harness":
            setState({ ...state, harnesses: { ...state.harnesses, [u.entity.id]: u.entity } });
            return;
          case "agent":
            setState({ ...state, agents: { ...state.agents, [u.entity.id]: u.entity } });
            return;
          case "thread":
            setState({ ...state, threads: { ...state.threads, [u.entity.id]: u.entity } });
            return;
          case "task":
            setState({ ...state, tasks: { ...state.tasks, [u.entity.id]: u.entity } });
            return;
          case "dossier":
            setState({ ...state, dossiers: { ...state.dossiers, [u.entity.agentId]: u.entity } });
            return;
          case "approval":
            setState({ ...state, approvals: { ...state.approvals, [u.entity.id]: u.entity } });
            return;
          case "settings":
            setState({ ...state, settings: u.entity });
            return;
          case "thoughtWindow":
            setState({ ...state, thoughtWindows: { ...state.thoughtWindows, [u.entity.agentId]: u.entity } });
            return;
          case "team":
            setState({ ...state, teams: { ...state.teams, [u.entity.id]: u.entity } });
            return;
          case "build":
            setState({ ...state, builds: { ...state.builds, [u.entity.id]: u.entity } });
            return;
          case "boardThread":
            setState({ ...state, boardThreads: { ...state.boardThreads, [u.entity.id]: u.entity } });
            return;
          case "guidance": {
            const { [u.entity.id]: _removed, ...rest } = state.guidance;
            setState({ ...state, guidance: u.entity.removed ? rest : { ...rest, [u.entity.id]: u.entity } });
            return;
          }
          case "run":
            return; // runs are shown through tasks for now
        }
      }
    }
  },
};

/**
 * Subscribe to a slice of state. The selector must return a reference that already
 * exists in state (e.g. `s => s.agents`), not a newly built array — derive lists
 * with useMemo in the component.
 */
export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(state));
}
