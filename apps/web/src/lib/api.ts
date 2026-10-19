// REST client for history queries. Live state comes through `realtime`.
import type { Message, SystemEvent, Task } from "@alliance/protocol";

const base = (import.meta.env.VITE_OVERSEER_URL ?? "").replace(/\/$/, "") + "/api";

async function get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined) qs.set(k, String(v));
  const res = await fetch(`${base}${path}${qs.size ? `?${qs}` : ""}`, { credentials: "include" });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return (await res.json()) as T;
}

export const api = {
  threadMessages: (threadId: string, before?: string, limit = 50) =>
    get<Message[]>(`/threads/${threadId}/messages`, { before, limit }),
  events: (q: { level?: string; source?: string; q?: string; before?: number }) => get<SystemEvent[]>("/events", q),
  tasks: (q: { status?: string; agentId?: string }) => get<Task[]>("/tasks", q),
  runEvents: (runId: string, afterSeq?: number) => get<SystemEvent[]>(`/runs/${runId}/events`, { afterSeq }),
};
