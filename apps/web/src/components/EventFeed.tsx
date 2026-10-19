import type { SystemEvent } from "@alliance/protocol";
import { clock } from "../lib/format";
import { Dot } from "./StatusBadge";

export function EventFeed({ events, limit = 50, dense }: { events: SystemEvent[]; limit?: number; dense?: boolean }) {
  if (events.length === 0) return <div className="empty">No events yet.</div>;
  return (
    <ol className={`feed${dense ? " feed-dense" : ""}`}>
      {events.slice(0, limit).map((e) => (
        <li key={e.id} className={`feed-item level-${e.level}`}>
          <Dot status={e.level} />
          <time className="feed-time mono">{clock(e.ts)}</time>
          <span className="feed-type mono">{e.type}</span>
          <span className="feed-summary">{e.summary}</span>
        </li>
      ))}
    </ol>
  );
}
