import type { ApprovalRoute, ApprovalRoutes, Risk, ToolGrant, ToolPolicy } from "@alliance/protocol";
import { ENVIRONMENT_TOOLS } from "../lib/tool-catalog";

const POLICIES: ToolPolicy[] = ["allow", "ask", "deny"];
const RISKS: Risk[] = ["low", "medium", "high"];
const ROUTES: { value: ApprovalRoute; label: string; help: string }[] = [
  { value: "approve", label: "Auto-approve", help: "Runs without asking anyone" },
  { value: "overseer", label: "Overseer → helper → you", help: "The Overseer decides; if unsure its helper decides by your guidance; only then you" },
  { value: "operator", label: "Always me", help: "Every call waits for you under Needs you" },
];

/** The grant for each catalog tool: the given one, or the tool's defaults. */
export function grantsFor(grants: ToolGrant[] | undefined): ToolGrant[] {
  return ENVIRONMENT_TOOLS.map((t) => grants?.find((g) => g.name === t.name) ?? { name: t.name, policy: t.defaultPolicy });
}

/** Policy (allow / ask / deny) and risk per tool. */
export function ToolPermissions({ grants, onChange }: { grants: ToolGrant[] | undefined; onChange: (grants: ToolGrant[]) => void }) {
  const current = grantsFor(grants);
  const set = (name: string, patch: Partial<ToolGrant>) => onChange(current.map((g) => (g.name === name ? { ...g, ...patch } : g)));
  return (
    <div className="tool-grid">
      {ENVIRONMENT_TOOLS.map((t) => {
        const g = current.find((x) => x.name === t.name)!;
        return (
          <div key={t.name} className="tool-row">
            <div>
              <div className="setting-label">{t.label}</div>
              <div className="setting-help">{t.description}</div>
            </div>
            <div className="tool-controls">
              <div className="segmented" role="radiogroup" aria-label={`${t.label} policy`}>
                {POLICIES.map((p) => (
                  <button type="button" key={p} role="radio" aria-checked={g.policy === p} className={`seg seg-${p}${g.policy === p ? " active" : ""}`} onClick={() => set(t.name, { policy: p })}>
                    {p}
                  </button>
                ))}
              </div>
              <label className="risk-select" title="Risk decides who approves it (see Approvals)">
                <span className="muted small">risk</span>
                <select className="input input-sm" value={g.risk ?? t.defaultRisk} disabled={g.policy !== "ask"} onChange={(e) => set(t.name, { risk: e.target.value as Risk })}>
                  {RISKS.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Who approves "ask" tool calls, per risk. With `defaults`, each risk can also follow
 * the server default (an agent's own settings).
 */
export function ApprovalRoutesEditor({
  routes,
  onChange,
  defaults,
}: {
  routes: Partial<ApprovalRoutes>;
  onChange: (routes: Partial<ApprovalRoutes>) => void;
  defaults?: ApprovalRoutes;
}) {
  return (
    <div className="tool-grid">
      {RISKS.map((risk) => {
        const value = routes[risk];
        const label = (r: ApprovalRoute) => ROUTES.find((x) => x.value === r)!.label;
        return (
          <div key={risk} className="tool-row">
            <div>
              <div className="setting-label"><span className={`risk risk-${risk}`}>{risk} risk</span></div>
              <div className="setting-help">{ROUTES.find((x) => x.value === (value ?? defaults?.[risk]))?.help}</div>
            </div>
            <select
              className="input route-select"
              value={value ?? ""}
              onChange={(e) => {
                const next = { ...routes };
                if (e.target.value) next[risk] = e.target.value as ApprovalRoute;
                else delete next[risk];
                onChange(next);
              }}
            >
              {defaults && <option value="">Default ({label(defaults[risk])})</option>}
              {ROUTES.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </div>
        );
      })}
    </div>
  );
}
