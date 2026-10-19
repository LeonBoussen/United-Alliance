import { useState } from "react";
import { Check, Copy, Download, Monitor, Server, X } from "lucide-react";
import type { HarnessBuild } from "@alliance/protocol";
import { realtime } from "../lib/realtime";
import { downloadBuild } from "../lib/builds";
import { relativeTime, useNow } from "../lib/format";
import { StatusBadge } from "./StatusBadge";

const STATUS_TONE: Record<HarnessBuild["status"], string> = { pending: "waiting", enrolled: "online", expired: "offline", revoked: "offline" };

export function BuildCard({ build, highlight }: { build: HarnessBuild; highlight?: boolean }) {
  const [copied, setCopied] = useState(false);
  const now = useNow(30_000);
  const expired = build.status === "pending" && new Date(build.expiresAt).getTime() < now;
  const status = expired ? "expired" : build.status;
  const usable = status === "pending";
  const OsIcon = build.os === "windows" ? Monitor : Server;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(build.installCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable: the command is selectable */
    }
  };

  return (
    <div className={`build-card${highlight ? " highlight" : ""}`}>
      <div className="build-head">
        <OsIcon size={16} />
        <b>{build.harnessName}</b>
        <span className="muted small">{build.os === "windows" ? "Windows" : "Linux"} host</span>
        <span className="spacer" />
        <StatusBadge status={STATUS_TONE[status]} label={status === "pending" ? "waiting for enrollment" : status} />
      </div>

      {usable && (
        <>
          <div className="build-actions">
            <button className="btn btn-primary" onClick={() => downloadBuild(build)}>
              <Download size={14} /> Download .zip
            </button>
            <span className="muted small">
              Unzip on the target machine and run <code>{build.os === "windows" ? "start.cmd" : "./start.sh"}</code>. Needs Python 3.10+.
            </span>
          </div>
          <div className="field">
            <span>Or install with one line ({build.os === "windows" ? "PowerShell" : "bash"})</span>
            <div className="cmd-row">
              <code className="cmd">{build.installCommand}</code>
              <button className="icon-btn" onClick={copy} aria-label="Copy install command" title="Copy">
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
            {realtime.isMock && <span className="setting-help">Demo mode: the one-liner needs a real Overseer. The zip download works.</span>}
          </div>
        </>
      )}

      <div className="build-foot muted small">
        Created {relativeTime(build.createdAt, now)}
        {usable && <> · single-use token expires {relativeTime(build.expiresAt, now).replace(" ago", "")}</>}
        {usable && (
          <button className="link-btn" onClick={() => confirm(`Revoke the build for ${build.harnessName}? The download will stop working.`) && realtime.send("build.revoke", { buildId: build.id })}>
            <X size={11} /> revoke
          </button>
        )}
      </div>
    </div>
  );
}
