export type Tone = "good" | "warn" | "bad" | "info" | "muted" | "accent";

const TONES: Record<string, Tone> = {
  // harness
  online: "good",
  degraded: "warn",
  offline: "muted",
  // agent
  idle: "good",
  busy: "accent",
  waiting: "warn",
  error: "bad",
  retired: "muted",
  // task
  queued: "muted",
  assigned: "info",
  running: "accent",
  paused: "warn",
  waiting_approval: "warn",
  succeeded: "good",
  failed: "bad",
  cancelled: "muted",
  // event level
  debug: "muted",
  info: "info",
  warn: "warn",
  // connection
  live: "good",
  mock: "info",
  connecting: "warn",
};

const PULSE = new Set(["busy", "running", "live", "connecting"]);

export function toneOf(status: string): Tone {
  return TONES[status] ?? "muted";
}

/** Status is always dot + word, never colour alone. */
export function StatusBadge({ status, label, subtle }: { status: string; label?: string; subtle?: boolean }) {
  const tone = toneOf(status);
  return (
    <span className={`badge badge-${tone}${subtle ? " badge-subtle" : ""}`}>
      <span className={`dot dot-${tone}${PULSE.has(status) ? " dot-pulse" : ""}`} aria-hidden />
      {label ?? status.replace(/_/g, " ")}
    </span>
  );
}

export function Dot({ status }: { status: string }) {
  const tone = toneOf(status);
  return <span className={`dot dot-${tone}${PULSE.has(status) ? " dot-pulse" : ""}`} title={status} aria-label={status} />;
}
