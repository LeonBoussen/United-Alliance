import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Monitor, Plus, Server } from "lucide-react";
import type { BuildOs } from "@alliance/protocol";
import { useStore } from "../lib/store";
import { realtime } from "../lib/realtime";
import { relativeTime, useNow } from "../lib/format";
import { BuildCard } from "../components/BuildCard";
import { Dot, StatusBadge } from "../components/StatusBadge";

/** Prefer a LAN address the overseer reports; fall back to how this browser reaches it. */
function defaultOverseerUrl(advertised: string[] | undefined): string {
  const lan = advertised?.find((u) => !u.includes("127.0.0.1"));
  if (lan) return lan;
  const { hostname, port, protocol } = window.location;
  return hostname === "localhost" ? `http://127.0.0.1:${port || 8080}` : `${protocol}//${hostname}:${port || 8080}`;
}

function AddHost({ onDone }: { onDone: () => void }) {
  const settings = useStore((s) => s.settings);
  const builds = useStore((s) => s.builds);
  const [os, setOs] = useState<BuildOs>("windows");
  const [name, setName] = useState("");
  const [overseerUrl, setOverseerUrl] = useState(() => defaultOverseerUrl(settings?.network.advertisedUrls));
  const [submitted, setSubmitted] = useState<{ at: string; name: string } | null>(null);
  // Same rule as the build generator: a plain http(s) URL, nothing that could break a script.
  const urlOk = /^https?:\/\/[^\s'"`$;&|<>\\]+$/.test(overseerUrl.trim());

  const result = useMemo(
    () => submitted && Object.values(builds).find((b) => b.harnessName === submitted.name && b.createdAt >= submitted.at),
    [builds, submitted],
  );

  if (submitted) {
    return (
      <section className="card pad settings-section">
        <h2 className="wizard-title">Host “{submitted.name}”</h2>
        {result ? (
          <>
            <p className="muted">Run this on the machine that should host agents. It connects on first start; from then on the Overseer spawns agents on it as work needs them.</p>
            <BuildCard build={result} highlight />
          </>
        ) : (
          <p className="muted">Generating the build…</p>
        )}
        <div className="form-actions">
          <button className="btn" onClick={() => { setSubmitted(null); setName(""); }}>Add another</button>
          <button className="btn" onClick={onDone}>Done</button>
        </div>
      </section>
    );
  }

  return (
    <form
      className="card pad settings-section"
      onSubmit={(e) => {
        e.preventDefault();
        const at = new Date(Date.now() - 1000).toISOString();
        realtime.send("host.create", { os, harnessName: name.trim(), overseerUrl: overseerUrl.trim() });
        setSubmitted({ at, name: name.trim() });
      }}
    >
      <h2 className="wizard-title">Add a host</h2>
      <p className="muted">
        A host is a machine that runs agents. It isn't an agent itself: the Overseer decides how many agents run on it and what they do.
        Starting it twice on one machine is safe; the second copy waits and takes over if the first stops.
      </p>
      <div className="provider-grid">
        <div className="field">
          <span>Operating system</span>
          <div className="segmented big">
            <button type="button" className={`seg${os === "windows" ? " active" : ""}`} onClick={() => setOs("windows")}><Monitor size={14} /> Windows</button>
            <button type="button" className={`seg${os === "linux" ? " active" : ""}`} onClick={() => setOs("linux")}><Server size={14} /> Linux</button>
          </div>
        </div>
        <label className="field">
          <span>Host name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. build-server-02" maxLength={40} required />
        </label>
        <label className="field full">
          <span>Overseer URL (as seen from that machine)</span>
          <input className="input mono" list="overseer-urls" value={overseerUrl} onChange={(e) => setOverseerUrl(e.target.value)} required aria-invalid={!urlOk} />
          <datalist id="overseer-urls">
            {(settings?.network.advertisedUrls ?? []).map((u) => (
              <option key={u} value={u} />
            ))}
          </datalist>
          {!urlOk && <span className="field-error">Enter a plain http(s) URL, e.g. http://192.168.1.20:8080</span>}
          <span className="setting-help">Use this server's LAN address (e.g. 192.168.x.x). While public access is off, the machine must be on a private network.</span>
        </label>
      </div>
      <div className="form-actions">
        <button type="button" className="btn" onClick={onDone}>Cancel</button>
        <button className="btn btn-primary" disabled={!name.trim() || !urlOk}>Generate {os === "windows" ? "Windows" : "Linux"} build</button>
      </div>
    </form>
  );
}

export function Hosts() {
  const harnesses = useStore((s) => s.harnesses);
  const agents = useStore((s) => s.agents);
  const builds = useStore((s) => s.builds);
  const [adding, setAdding] = useState(false);
  const now = useNow(30_000);

  const hosts = useMemo(() => Object.values(harnesses).sort((a, b) => a.name.localeCompare(b.name)), [harnesses]);
  const pending = useMemo(
    () => Object.values(builds).filter((b) => b.status === "pending" && new Date(b.expiresAt).getTime() > now).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [builds, now],
  );
  const onHost = (id: string) => Object.values(agents).filter((a) => a.harnessId === id && a.status !== "retired");

  return (
    <div className="page settings">
      {adding ? (
        <AddHost onDone={() => setAdding(false)} />
      ) : (
        <div className="toolbar">
          <p className="muted">Machines that run agents. The Overseer fills their seats with agents as work needs them and retires agents that finish, fail or sit idle.</p>
          <button className="btn btn-primary" onClick={() => setAdding(true)}><Plus size={14} /> Add host</button>
        </div>
      )}

      {hosts.length === 0 && !adding && <div className="card pad empty">No hosts yet. Add one and run its build on a Windows or Linux machine (Python 3.10+).</div>}

      <div className="provider-list">
        {hosts.map((h) => {
          const list = onHost(h.id);
          return (
            <section key={h.id} className="card pad host-card">
              <header className="host-head">
                {h.os === "linux" ? <Server size={16} /> : <Monitor size={16} />}
                <b>{h.name}</b>
                <span className="muted small">{h.host || "—"} · v{h.version || "?"}{h.sourceHash ? ` (${h.sourceHash.slice(0, 8)})` : ""}</span>
                <span className="spacer" />
                {h.updateAvailable && <span className="tag">update available</span>}
                <StatusBadge status={h.status} />
              </header>
              <div className="host-seats" aria-label={`${list.length} of ${h.slots.total} seats used`}>
                {Array.from({ length: Math.max(h.slots.total, list.length) }, (_, i) => (
                  <span key={i} className={`seat${i < list.length ? " taken" : ""}`} />
                ))}
                <span className="muted small">{list.length}/{h.slots.total} seats · {h.slots.used} running{h.status === "offline" ? ` · last seen ${relativeTime(h.lastHeartbeatAt, now)}` : ""}</span>
              </div>
              {list.length > 0 ? (
                <ul className="host-agents">
                  {list.map((a) => (
                    <li key={a.id}>
                      <Link to={`/agents/${a.id}`} className="context-item">
                        <Dot status={a.status} />
                        <div>
                          <div className="context-name">{a.name} <span className="muted">· {a.role}</span></div>
                          <div className="context-focus">{a.currentFocus}</div>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="muted small">No agents right now. The Overseer spawns them here when there's work.</div>
              )}
            </section>
          );
        })}
      </div>

      {pending.length > 0 && (
        <section className="card pad settings-section">
          <h3 className="section-title">Waiting to connect</h3>
          <div className="provider-list">
            {pending.map((b) => (
              <BuildCard key={b.id} build={b} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
