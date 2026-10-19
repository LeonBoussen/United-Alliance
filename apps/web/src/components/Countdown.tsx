import { useNow } from "../lib/format";

/** m:ss until a timestamp; "0:00" once passed. */
export function Countdown({ until }: { until: string }) {
  const now = useNow(1000);
  const s = Math.max(0, Math.round((new Date(until).getTime() - now) / 1000));
  return (
    <span className="mono countdown">
      {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
    </span>
  );
}
