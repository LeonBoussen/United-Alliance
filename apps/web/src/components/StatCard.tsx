import type { ReactNode } from "react";
import { Sparkline } from "./Charts";

export function StatCard({ label, value, hint, trend }: { label: string; value: ReactNode; hint?: ReactNode; trend?: number[] }) {
  return (
    <div className="card stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {trend ? <Sparkline values={trend} /> : <div className="stat-hint">{hint}</div>}
    </div>
  );
}
