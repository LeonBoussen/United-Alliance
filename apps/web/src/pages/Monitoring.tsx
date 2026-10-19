import { useMemo, useState } from "react";
import { Pause, Play } from "lucide-react";
import type { EventLevel, SystemEvent } from "@alliance/protocol";
import { useStore } from "../lib/store";
import { realtime } from "../lib/realtime";
import { num, relativeTime, usd, useNow } from "../lib/format";
import { LineChart } from "../components/Charts";
import { EventFeed } from "../components/EventFeed";
import { StatusBadge } from "../components/StatusBadge";
import { ProgressBar } from "../components/TaskRow";

const LEVELS: EventLevel[] = ["debug", "info", "warn", "error"];

export function Monitoring() {
  const metrics = useStore((s) => s.metrics);
  const harnesses = useStore((s) => s.harnesses);
  const events = useStore((s) => s.events);
  const now = useNow(2000);

  const [levels, setLevels] = useState<Set<EventLevel>>(new Set(["info", "warn", "error"]));
  const [query, setQuery] = useState("");
  const [frozen, setFrozen] = useState<SystemEvent[] | null>(null);

  const times = useMemo(() => metrics.map((m) => m.ts), [metrics]);
  const series = useMemo(
    () => ({
      tokens: metrics.map((m) => m.tokensPerMin),
      cost: metrics.map((m) => m.costTodayUsd),
      runs: metrics.map((m) => m.runsActive),
    }),
    [metrics],
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (frozen ?? events).filter((e) => levels.has(e.level) && (!q || `${e.type} ${e.summary}`.toLowerCase().includes(q)));
  }, [events, frozen, levels, query]);

  const toggleLevel = (l: EventLevel) =>
    setLevels((prev) => {
      const next = new Set(prev);
      if (next.has(l)) next.delete(l);
      else next.add(l);
      return next;
    });

  return (
    <div className="page">
      <section className="chart-row">
        <div className="card pad">
          <h3 className="section-title">Tokens per minute</h3>
          <LineChart values={series.tokens} times={times} format={num} />
        </div>
        <div className="card pad">
          <h3 className="section-title">Cost today (USD)</h3>
          <LineChart values={series.cost} times={times} format={usd} />
        </div>
        <div className="card pad">
          <h3 className="section-title">Active runs</h3>
          <LineChart values={series.runs} times={times} format={(n) => n.toFixed(0)} zeroBased />
        </div>
      </section>

      <section className="panel">
        <header className="panel-head"><h2>Harness health</h2></header>
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Harness</th>
                <th>Status</th>
                <th>Host</th>
                <th>Heartbeat</th>
                <th>Slots</th>
                <th>CPU</th>
                <th>Memory</th>
                <th>Version</th>
                <th>Capabilities</th>
              </tr>
            </thead>
            <tbody>
              {Object.values(harnesses).map((h) => (
                <tr key={h.id}>
                  <td><b>{h.name}</b></td>
                  <td><StatusBadge status={h.status} /></td>
                  <td className="mono">{h.host}</td>
                  <td>{relativeTime(h.lastHeartbeatAt, now)}</td>
                  <td className="mono">{h.slots.used}/{h.slots.total}</td>
                  <td className="cpu-cell">
                    {h.load ? <><ProgressBar value={h.load.cpu} tone={h.load.cpu > 0.85 ? "bad" : h.load.cpu > 0.65 ? "warn" : "good"} /><span className="mono">{Math.round(h.load.cpu * 100)}%</span></> : "—"}
                  </td>
                  <td className="mono">{h.load ? `${(h.load.memMb / 1024).toFixed(1)} GB` : "—"}</td>
                  <td className="small">
                    <span className="mono">{h.sourceHash ? h.sourceHash.slice(0, 8) : h.version || "—"}</span>
                    {h.updateStatus && h.updateStatus !== "idle" ? (
                      <span className="muted"> · update {h.updateStatus}</span>
                    ) : h.updateAvailable ? (
                      <>
                        {" "}
                        <button className="btn btn-sm" disabled={h.status === "offline"} onClick={() => realtime.send("harness.update", { harnessId: h.id })}>
                          Update
                        </button>
                      </>
                    ) : h.sourceHash ? (
                      <span className="muted"> · latest</span>
                    ) : null}
                  </td>
                  <td className="muted small">{h.capabilities.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <header className="panel-head">
          <h2>Event log</h2>
          <div className="toolbar tight">
            <div className="chips">
              {LEVELS.map((l) => (
                <button key={l} className={`chip${levels.has(l) ? " active" : ""}`} aria-pressed={levels.has(l)} onClick={() => toggleLevel(l)}>
                  <StatusBadge status={l} subtle />
                </button>
              ))}
            </div>
            <input className="input search" placeholder="Filter events…" value={query} onChange={(e) => setQuery(e.target.value)} />
            <button className="btn" onClick={() => setFrozen(frozen ? null : events)} aria-pressed={!!frozen}>
              {frozen ? <><Play size={14} /> Resume</> : <><Pause size={14} /> Pause</>}
            </button>
          </div>
        </header>
        <div className="card feed-card tall">
          <EventFeed events={shown} limit={300} />
        </div>
      </section>
    </div>
  );
}
