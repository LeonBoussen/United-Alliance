import { useRef, useState } from "react";
import { clock } from "../lib/format";

function path(values: number[], w: number, h: number, min: number, max: number) {
  const span = max - min || 1;
  return values
    .map((v, i) => {
      const x = values.length === 1 ? w : (i / (values.length - 1)) * w;
      const y = h - ((v - min) / span) * h;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

/** Tiny single-series trend for stat tiles. No axes, no hover. */
export function Sparkline({ values, height = 28 }: { values: number[]; height?: number }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  return (
    <svg className="sparkline" viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" height={height} aria-hidden>
      <path d={path(values, 100, height - 2, min, max)} transform="translate(0,1)" fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** Single-series line chart with crosshair + tooltip. The card title names the series. */
export function LineChart({
  values,
  times,
  format,
  height = 160,
  zeroBased = false,
}: {
  values: number[];
  times: string[];
  format: (n: number) => string;
  height?: number;
  zeroBased?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  if (values.length < 2) return <div className="chart-empty" style={{ height }}>Waiting for data…</div>;

  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const pad = (rawMax - rawMin) * 0.1 || 1;
  const min = zeroBased ? 0 : Math.max(0, rawMin - pad);
  const max = rawMax + pad;
  const w = 1000;

  const onMove = (e: React.MouseEvent) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const f = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    setHover(Math.round(f * (values.length - 1)));
  };

  const hv = hover !== null ? values[hover] : undefined;
  const hx = hover !== null ? (hover / (values.length - 1)) * 100 : 0;
  const hy = hv !== undefined ? (1 - (hv - min) / (max - min)) * 100 : 0;

  return (
    <div className="linechart" style={{ height }}>
      <div className="linechart-axis">
        <span>{format(max)}</span>
        <span>{format((max + min) / 2)}</span>
        <span>{format(min)}</span>
      </div>
      <div className="linechart-plot" ref={ref} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${w} 100`} preserveAspectRatio="none" width="100%" height="100%" aria-label="Line chart">
          {[0, 50, 100].map((y) => (
            <line key={y} x1="0" x2={w} y1={y} y2={y} stroke="var(--border)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          ))}
          <path d={path(values, w, 100, min, max)} fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
        </svg>
        {hover !== null && hv !== undefined && (
          <>
            <div className="crosshair" style={{ left: `${hx}%` }} />
            <div className="chart-marker" style={{ left: `${hx}%`, top: `${hy}%` }} />
            <div className={`chart-tip${hx > 70 ? " left" : ""}`} style={{ left: `${hx}%` }}>
              <b>{format(hv)}</b>
              <span>{times[hover] ? clock(times[hover] as string) : ""}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
