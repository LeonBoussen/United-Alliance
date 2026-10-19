import { useMemo } from "react";
import type { Approval, Message, Thread } from "@alliance/protocol";
import { useStore } from "./store";

export type NeedsYouItem =
  | { kind: "escalation"; message: Message; thread: Thread }
  | { kind: "question"; message: Message; thread: Thread }
  | { kind: "approval"; approval: Approval };

/** Everything waiting on the operator: overseer escalations, agent questions, approvals. */
export function useNeedsYou(): NeedsYouItem[] {
  const threads = useStore((s) => s.threads);
  const messages = useStore((s) => s.messages);
  const approvals = useStore((s) => s.approvals);

  return useMemo(() => {
    const items: NeedsYouItem[] = [];
    for (const [threadId, list] of Object.entries(messages)) {
      const thread = threads[threadId];
      if (!thread) continue;
      for (const m of list) {
        if (m.resolved !== false) continue;
        if (m.kind === "escalation") items.push({ kind: "escalation", message: m, thread });
        if (m.kind === "question") items.push({ kind: "question", message: m, thread });
      }
    }
    // Approvals still with the Overseer or its helper aren't waiting on the operator yet.
    for (const a of Object.values(approvals)) if (a.status === "pending" && (a.stage ?? "operator") === "operator") items.push({ kind: "approval", approval: a });
    return items;
  }, [threads, messages, approvals]);
}
