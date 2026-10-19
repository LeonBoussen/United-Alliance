import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { useStore } from "../lib/store";
import { usd } from "../lib/format";

type Theme = "dark" | "light";

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem("ua-theme");
    if (saved === "dark" || saved === "light") return saved;
  } catch {
    /* storage unavailable */
  }
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function TopBar({ title }: { title: string }) {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const metrics = useStore((s) => s.metrics);
  const m = metrics.at(-1);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("ua-theme", theme);
    } catch {
      /* storage unavailable */
    }
  }, [theme]);

  return (
    <header className="topbar">
      <h1 className="topbar-title">{title}</h1>
      <div className="topbar-stats">
        {m && (
          <>
            <span className="topbar-stat"><b>{m.agentsOnline}</b>/{m.agentsTotal} agents</span>
            <span className="topbar-stat"><b>{m.runsActive}</b> runs</span>
            <span className="topbar-stat"><b>{usd(m.costTodayUsd)}</b> today</span>
          </>
        )}
        <button
          className="icon-btn"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          title="Toggle theme"
        >
          {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      </div>
    </header>
  );
}
