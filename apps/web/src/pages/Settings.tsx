import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Bot, CheckCircle2, Globe, KeyRound, Lock, PlugZap, RefreshCw, Shield, Trash2, Users } from "lucide-react";
import { DATA_RESET_CONFIRM, type Effort, type ProviderSettings, type ServerSettings, type SettingsPatch } from "@alliance/protocol";
import { ApprovalRoutesEditor, ToolPermissions } from "../components/Permissions";
import { useStore } from "../lib/store";
import { realtime } from "../lib/realtime";
import { relativeTime, useNow } from "../lib/format";
import { StatusBadge } from "../components/StatusBadge";

const PRIVATE_RANGES = [
  ["127.0.0.0/8, ::1", "this machine"],
  ["10.0.0.0/8", "private"],
  ["172.16.0.0/12", "private"],
  ["192.168.0.0/16", "private"],
  ["169.254.0.0/16, fe80::/10", "link-local"],
  ["fc00::/7", "IPv6 unique local"],
] as const;

const update = (patch: SettingsPatch) => realtime.send("settings.update", { patch });

function Locked({ settings, path }: { settings: ServerSettings; path: string }) {
  if (!settings.locked.includes(path)) return null;
  return (
    <span className="tag" title="Set by an environment variable on the server">
      <Lock size={11} /> env
    </span>
  );
}

function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`switch${checked ? " on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" />
    </button>
  );
}

function NetworkSection({ s }: { s: ServerSettings }) {
  const [cidr, setCidr] = useState("");
  const n = s.network;
  const lockedPublic = s.locked.includes("network.allowPublic");

  return (
    <section className="card pad settings-section">
      <header className="settings-head">
        <Globe size={18} />
        <div>
          <h2>Network access</h2>
          <p className="muted">Who can connect to the Overseer: the console, harnesses, and the model gateway.</p>
        </div>
      </header>

      <div className="setting-row">
        <div>
          <div className="setting-label">
            Allow public internet <Locked settings={s} path="network.allowPublic" />
          </div>
          <div className="setting-help">
            Off: only this machine and private networks can connect. On: any address can connect; operator login is required.
          </div>
        </div>
        <div className="setting-control">
          <StatusBadge status={n.allowPublic ? "warn" : "online"} label={n.allowPublic ? "Public" : "Private only"} />
          <Toggle
            label="Allow public internet"
            checked={n.allowPublic}
            disabled={lockedPublic || (!n.allowPublic && !s.operatorAuthConfigured)}
            onChange={(v) => {
              if (v && !confirm("Expose the Overseer to the public internet? Anyone who can reach this machine will be able to try to connect.")) return;
              update({ network: { allowPublic: v } });
            }}
          />
        </div>
      </div>
      {!n.allowPublic && !s.operatorAuthConfigured && (
        <div className="notice">
          <Shield size={14} /> Public access can't be turned on until operator login is configured.
        </div>
      )}
      {n.allowPublic && (
        <div className="notice warn">
          <AlertTriangle size={14} /> The Overseer accepts connections from any address. Use TLS (a reverse proxy) and strong operator credentials.
        </div>
      )}

      <div className="setting-row column">
        <div className="setting-label">Always allowed while private</div>
        <ul className="range-list">
          {PRIVATE_RANGES.map(([r, what]) => (
            <li key={r}>
              <code>{r}</code> <span className="muted">{what}</span>
            </li>
          ))}
          {n.extraAllowedCidrs.map((c) => (
            <li key={c}>
              <code>{c}</code> <span className="muted">added by you</span>
              <button className="link-btn" onClick={() => update({ network: { extraAllowedCidrs: n.extraAllowedCidrs.filter((x) => x !== c) } })}>
                remove
              </button>
            </li>
          ))}
        </ul>
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            const v = cidr.trim();
            if (v && !n.extraAllowedCidrs.includes(v)) update({ network: { extraAllowedCidrs: [...n.extraAllowedCidrs, v] } });
            setCidr("");
          }}
        >
          <input className="input" placeholder="Add a range, e.g. 100.64.0.0/10 (Tailscale)" value={cidr} onChange={(e) => setCidr(e.target.value)} pattern="[0-9a-fA-F:.]+/\d{1,3}" title="CIDR, e.g. 100.64.0.0/10" />
          <button className="btn" disabled={!cidr.trim()}>Add</button>
        </form>
      </div>

      <div className="setting-row">
        <div>
          <div className="setting-label">Listen address <Locked settings={s} path="network.bindHost" /></div>
          <div className="setting-help">
            <code>0.0.0.0</code> listens on all interfaces so harnesses on your LAN can connect; the rules above still apply. Use <code>127.0.0.1</code> for this machine only. Needs a restart.
          </div>
        </div>
        <code className="setting-value">{n.bindHost}:{n.port}</code>
      </div>
      {n.advertisedUrls.length > 0 && (
        <div className="setting-row column">
          <div className="setting-label">Addresses harnesses can use</div>
          <ul className="range-list">
            {n.advertisedUrls.map((u) => (
              <li key={u}><code>{u}</code></li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

function ApprovalsSection({ s }: { s: ServerSettings }) {
  return (
    <section className="card pad settings-section">
      <header className="settings-head">
        <CheckCircle2 size={18} />
        <div>
          <h2>Approvals</h2>
          <p className="muted">
            Who decides when an agent calls a tool set to “ask”, by the tool's risk. The Overseer and its helper decide by your guidance
            (Helper page) and earlier decisions, in one short line; you're asked only when neither is sure. Each agent can override this on its Permissions tab.
          </p>
        </div>
      </header>
      <ApprovalRoutesEditor routes={s.approvals} onChange={(r) => update({ approvals: r })} />
    </section>
  );
}

function WorkersSection({ s }: { s: ServerSettings }) {
  const w = s.workers;

  return (
    <section className="card pad settings-section">
      <header className="settings-head">
        <Bot size={18} />
        <div>
          <h2>Workers &amp; autonomy</h2>
          <p className="muted">The Overseer spawns agents on your hosts as work needs them and retires them when they fail, stop or sit idle.</p>
        </div>
      </header>
      <div className="provider-grid three">
        <label className="field">
          <span>Max agents</span>
          <input className="input" type="number" min={1} max={200} defaultValue={w.maxAgents} onBlur={(e) => update({ workers: { maxAgents: Number(e.target.value) } })} />
          <span className="setting-help">Across all hosts. Each host also has its own number of seats.</span>
        </label>
        <label className="field">
          <span>Retire idle agents after (minutes)</span>
          <input className="input" type="number" min={0} max={1440} defaultValue={w.idleRetireMinutes} onBlur={(e) => update({ workers: { idleRetireMinutes: Number(e.target.value) } })} />
          <span className="setting-help">0 keeps idle agents. Agents you spawned yourself are never retired automatically.</span>
        </label>
        <label className="field">
          <span>Effort</span>
          <select className="input" value={w.effort} onChange={(e) => update({ workers: { effort: e.target.value as Effort } })}>
            {EFFORTS.map((x) => (
              <option key={x} value={x}>{x}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="setting-label">Default tool permissions for new agents</div>
      <ToolPermissions grants={w.defaultTools} onChange={(g) => update({ workers: { defaultTools: g } })} />
      <div className="setting-row">
        <div>
          <div className="setting-label">Follow up on results</div>
          <div className="setting-help">
            When a task finishes or fails, the Overseer gets a turn to act: start the next step, retry with a new agent, or report back. This is what lets it run long, multi-step goals on its own.
          </div>
        </div>
        <div className="setting-control">
          <Toggle label="Follow up on results" checked={s.autonomy.followUps} onChange={(v) => update({ autonomy: { followUps: v } })} />
        </div>
      </div>
      <label className="field">
        <span>Follow-ups per conversation per hour</span>
        <input className="input" type="number" min={1} max={200} defaultValue={s.autonomy.maxFollowUpsPerHour} onBlur={(e) => update({ autonomy: { maxFollowUpsPerHour: Number(e.target.value) } })} />
        <span className="setting-help">A brake on runaway loops. When it's hit, the Overseer waits for you.</span>
      </label>
    </section>
  );
}

function ProviderCard({ p, isDefault }: { p: ProviderSettings; isDefault: boolean }) {
  const [key, setKey] = useState("");
  const [editing, setEditing] = useState(!p.keySet);
  const now = useNow(30_000);

  if (!p.available) {
    return (
      <div className="provider-card disabled">
        <div className="provider-head">
          <b>{p.label}</b>
          <span className="tag">coming later</span>
        </div>
        <p className="muted small">The adapter isn't built yet. It will appear here when it is.</p>
      </div>
    );
  }

  return (
    <div className="provider-card">
      <div className="provider-head">
        <b>{p.label}</b>
        {isDefault && <span className="tag tag-accent">default</span>}
        <span className="spacer" />
        <Toggle label={`Enable ${p.label}`} checked={p.enabled} onChange={(v) => update({ providers: [{ id: p.id, enabled: v }] })} />
      </div>

      <div className="field">
        <span>API key</span>
        {p.keySet && !editing ? (
          <div className="key-row">
            <KeyRound size={14} />
            <code>{p.keyHint}</code>
            <span className="muted small">set {relativeTime(p.keyUpdatedAt, now)}</span>
            <span className="spacer" />
            <button className="btn btn-sm" onClick={() => setEditing(true)}>Replace</button>
            <button className="btn btn-sm" onClick={() => confirm(`Remove the ${p.label} API key? Agents using it will pause.`) && realtime.send("provider.setKey", { provider: p.id, apiKey: "" })}>
              Clear
            </button>
          </div>
        ) : (
          <form
            className="key-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (!key.trim()) return;
              realtime.send("provider.setKey", { provider: p.id, apiKey: key.trim() });
              setKey("");
              setEditing(false);
            }}
          >
            <input className="input grow" type="password" autoComplete="off" placeholder="sk-…" value={key} onChange={(e) => setKey(e.target.value)} />
            <button className="btn btn-primary" disabled={!key.trim()}>Save</button>
            {p.keySet && <button type="button" className="btn" onClick={() => setEditing(false)}>Cancel</button>}
          </form>
        )}
        <span className="setting-help">Stored encrypted on the server. It's never shown again or sent back to this console.</span>
      </div>

      <div className="provider-grid">
        <label className="field">
          <span>Default model</span>
          <select className="input" value={p.defaultModel} onChange={(e) => update({ providers: [{ id: p.id, defaultModel: e.target.value }] })}>
            {p.models.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Base URL</span>
          <input
            className="input mono"
            defaultValue={p.baseUrl}
            onBlur={(e) => e.target.value !== p.baseUrl && update({ providers: [{ id: p.id, baseUrl: e.target.value }] })}
          />
        </label>
      </div>

      <div className="provider-foot">
        <button className="btn" onClick={() => realtime.send("provider.test", { provider: p.id })}>
          <PlugZap size={14} /> Test connection
        </button>
        <span className="muted small">The result appears in the event log.</span>
      </div>
    </div>
  );
}

function DataSection({ onReset }: { onReset: () => void }) {
  const connection = useStore((st) => st.connection);
  const [step, setStep] = useState<"idle" | "confirm" | "sent" | "done">("idle");
  const [typed, setTyped] = useState("");
  const [wentOffline, setWentOffline] = useState(false);

  // The Overseer restarts after wiping: done once the console has dropped and reconnected.
  useEffect(() => {
    if (step !== "sent") return;
    if (connection === "offline" || connection === "connecting") setWentOffline(true);
    else if (wentOffline || connection === "mock") {
      setStep("done");
      onReset();
    }
  }, [step, connection, wentOffline, onReset]);

  return (
    <section className="card pad settings-section danger">
      <header className="settings-head">
        <Trash2 size={18} />
        <div>
          <h2>Remove all data</h2>
          <p className="muted">
            Deletes everything the Overseer stores: teams, agents, hosts, conversations, tasks, the board, the helper's guidance, memories,
            the event log, these settings and the API keys. The Overseer restarts empty, as on its first start.
            {realtime.isMock && " In the demo, this brings back the demo data."}
          </p>
        </div>
      </header>
      {step === "idle" || step === "done" ? (
        <div className="setting-row">
          <div className="setting-help">
            Hosts lose their enrollment and can't reconnect. Delete their harness folders and add them again from Hosts. This can't be undone.
          </div>
          <div className="setting-control">
            {step === "done" && <span className="muted small">All data removed.</span>}
            <button className="btn btn-danger" onClick={() => setStep("confirm")}>Remove all data…</button>
          </div>
        </div>
      ) : step === "confirm" ? (
        <form
          className="setting-row column"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed.trim().toLowerCase() !== "delete") return;
            realtime.send("data.reset", { confirm: DATA_RESET_CONFIRM });
            setTyped("");
            setWentOffline(false);
            setStep("sent");
          }}
        >
          <label className="setting-label" htmlFor="reset-confirm">
            Type <code>delete</code> to remove all data
          </label>
          <div className="inline-form">
            <input id="reset-confirm" className="input" autoComplete="off" autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
            <button className="btn btn-danger" disabled={typed.trim().toLowerCase() !== "delete"}>Remove everything</button>
            <button type="button" className="btn" onClick={() => { setTyped(""); setStep("idle"); }}>Cancel</button>
          </div>
        </form>
      ) : (
        <div className="notice warn">
          <RefreshCw size={14} /> Removing all data. The Overseer restarts and this console reconnects by itself.
        </div>
      )}
    </section>
  );
}

export function Settings() {
  const s = useStore((st) => st.settings);
  // Bumped after a reset so the sections below remount with the new (default) values.
  const [resets, setResets] = useState(0);
  const onReset = useCallback(() => setResets((n) => n + 1), []);
  if (!s) return <div className="page"><div className="empty">Loading settings…</div></div>;

  return (
    <div className="page settings">
      <div key={resets} className="settings-sections">
        <NetworkSection s={s} />
        <WorkersSection s={s} />
        <ApprovalsSection s={s} />

        <section className="card pad settings-section">
          <header className="settings-head">
            <RefreshCw size={18} />
            <div>
              <h2>Harness updates</h2>
              <p className="muted">How harnesses get new tools and features. Updates install between tasks, never mid-task, and roll back if the new version fails to start.</p>
            </div>
          </header>
          <div className="radio-cards">
            {(
              [
                ["automatic", "Automatic (recommended)", "When the harness code on the Overseer changes, every connected harness updates itself after its current tasks."],
                ["manual", "Manual", "Harnesses show “update available” in Monitoring; you choose when each one updates."],
              ] as const
            ).map(([value, title, help]) => (
              <label key={value} className={`radio-card${s.updates.mode === value ? " active" : ""}`}>
                <input type="radio" name="updates" checked={s.updates.mode === value} onChange={() => update({ updates: { mode: value } })} />
                <div>
                  <div className="setting-label">{title}</div>
                  <div className="setting-help">{help}</div>
                </div>
              </label>
            ))}
          </div>
        </section>

        <section className="card pad settings-section">
          <header className="settings-head">
            <KeyRound size={18} />
            <div>
              <h2>Model providers</h2>
              <p className="muted">The Overseer gives agents access to these. Harnesses are never configured with keys.</p>
            </div>
          </header>
          <div className="provider-list">
            {s.providers.map((p) => (
              <ProviderCard key={p.id} p={p} isDefault={s.defaultProvider === p.id} />
            ))}
          </div>
        </section>

        <section className="card pad settings-section">
          <header className="settings-head">
            <Shield size={18} />
            <div>
              <h2>Credential delivery</h2>
              <p className="muted">How harnesses use the keys above.</p>
            </div>
          </header>
          <div className="radio-cards">
            {(
              [
                ["gateway", "Through the Overseer (recommended)", "Agents get a short-lived token and call the model via the Overseer's gateway. The real key never leaves the server; usage and budgets are exact."],
                ["direct", "Directly to the provider", "The Overseer sends the real key to each harness (kept in memory). One less hop, but the key lives on every harness machine and budgets are enforced by harnesses."],
              ] as const
            ).map(([value, title, help]) => (
              <label key={value} className={`radio-card${s.credentials.delivery === value ? " active" : ""}`}>
                <input type="radio" name="delivery" checked={s.credentials.delivery === value} onChange={() => update({ credentials: { delivery: value } })} />
                <div>
                  <div className="setting-label">{title}</div>
                  <div className="setting-help">{help}</div>
                </div>
              </label>
            ))}
          </div>
        </section>

        <section className="card pad settings-section">
          <header className="settings-head">
            <Users size={18} />
            <div>
              <h2>Chain of command</h2>
              <p className="muted">Agents ask the Overseer. After you insert a thought, the agent may reply to you for a while.</p>
            </div>
          </header>
          <div className="provider-grid">
            <label className="field">
              <span>Thought window (minutes)</span>
              <input
                className="input"
                type="number"
                min={1}
                max={240}
                defaultValue={s.chainOfCommand.thoughtWindowMinutes}
                onBlur={(e) => update({ chainOfCommand: { thoughtWindowMinutes: Number(e.target.value) } })}
              />
              <span className="setting-help">How long after a thought the agent may reply to you and ask questions.</span>
            </label>
            <label className="field">
              <span>Overseer answers after (minutes)</span>
              <input
                className="input"
                type="number"
                min={1}
                max={120}
                defaultValue={s.chainOfCommand.operatorAnswerTimeoutMinutes}
                onBlur={(e) => update({ chainOfCommand: { operatorAnswerTimeoutMinutes: Number(e.target.value) } })}
              />
              <span className="setting-help">If you don't answer an agent's question in time, the Overseer answers it.</span>
            </label>
          </div>
        </section>
      </div>

      <DataSection onReset={onReset} />
    </div>
  );
}
