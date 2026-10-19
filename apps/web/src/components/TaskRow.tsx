import type { Task, TaskSignal } from "@alliance/protocol";
import { Pause, Play, RotateCcw, X } from "lucide-react";
import { useStore } from "../lib/store";
import { realtime } from "../lib/realtime";
import { duration, num } from "../lib/format";
import { StatusBadge } from "./StatusBadge";

export function ProgressBar({ value, tone = "accent" }: { value: number; tone?: "accent" | "warn" | "bad" | "good" }) {
  const pctValue = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className="progress" role="progressbar" aria-valuenow={pctValue} aria-valuemin={0} aria-valuemax={100}>
      <div className={`progress-fill tone-${tone}`} style={{ width: `${pctValue}%` }} />
    </div>
  );
}

function actionsFor(status: Task["status"]): TaskSignal[] {
  switch (status) {
    case "running":
    case "assigned":
    case "waiting_approval":
      return ["pause", "cancel"];
    case "paused":
      return ["resume", "cancel"];
    case "queued":
      return ["cancel"];
    case "failed":
    case "cancelled":
      return ["retry"];
    default:
      return [];
  }
}

const ICONS = { pause: Pause, resume: Play, cancel: X, retry: RotateCcw } as const;

export function TaskRow({ task, compact }: { task: Task; compact?: boolean }) {
  const agent = useStore((s) => (task.agentId ? s.agents[task.agentId] : undefined));
  const budget = task.budget?.tokens;
  const budgetUse = budget ? task.usedTokens / budget : 0;
  const progressTone = task.status === "failed" ? "bad" : task.status === "succeeded" ? "good" : task.status === "paused" || task.status === "waiting_approval" ? "warn" : "accent";

  return (
    <div className={`task-row${compact ? " compact" : ""}`}>
      <div className="task-main">
        <div className="task-title">
          {task.priority === "high" || task.priority === "urgent" ? <span className={`prio prio-${task.priority}`}>{task.priority}</span> : null}
          {task.title}
        </div>
        <div className="task-sub">
          {agent ? agent.name : "Unassigned"}
          {task.progressNote ? ` · ${task.progressNote}` : ""}
        </div>
      </div>

      <StatusBadge status={task.status} />

      <div className="task-progress">
        <ProgressBar value={task.progress ?? 0} tone={progressTone} />
        <span className="task-pct mono">{Math.round((task.progress ?? 0) * 100)}%</span>
      </div>

      {!compact && (
        <>
          <div className="task-budget" title={budget ? `${num(task.usedTokens)} of ${num(budget)} tokens` : `${num(task.usedTokens)} tokens`}>
            <span className="mono">{num(task.usedTokens)}{budget ? ` / ${num(budget)}` : ""}</span>
            {budget ? <ProgressBar value={budgetUse} tone={budgetUse > 0.9 ? "bad" : budgetUse > 0.7 ? "warn" : "good"} /> : null}
          </div>
          <div className="task-meta mono" title="Duration · checkpoints · attempt">
            {duration(task.startedAt, task.finishedAt)} · {task.checkpointCount} ckpt · #{task.attempt}
          </div>
          <div className="task-actions">
            {actionsFor(task.status).map((sig) => {
              const Icon = ICONS[sig];
              return (
                <button key={sig} className="icon-btn" title={sig} aria-label={`${sig} task`} onClick={() => realtime.send("task.signal", { taskId: task.id, signal: sig })}>
                  <Icon size={14} />
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
