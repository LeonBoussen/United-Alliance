// Overseer entry point: storage, state, hubs, scheduler, Overseer agent, HTTP + WebSocket
// server with the network guard in front of everything.
import { mkdirSync, rmSync, watch } from "node:fs";
import type { Socket } from "node:net";
import { join } from "node:path";
import Fastify from "fastify";
import type { WebSocket } from "ws";
import type { MetricsSnapshot } from "@alliance/protocol";
import type { App } from "./app.js";
import { Approvals } from "./approvals.js";
import { Board } from "./board.js";
import { DATA_FILES, RESTART_EXIT_CODE, loadConfig } from "./config.js";
import { Core } from "./core.js";
import { Db } from "./db.js";
import { envelope } from "./envelope.js";
import { HarnessHub } from "./harness-hub.js";
import { HelperAgent } from "./helper-agent.js";
import { registerRoutes } from "./http.js";
import { nowIso } from "./ids.js";
import { OverseerAgent } from "./overseer-agent.js";
import { Scheduler } from "./scheduler.js";
import { Secrets } from "./secrets.js";
import { createNetworkGuard } from "./security/network.js";
import { UiHub } from "./ui-hub.js";
import { Workers } from "./workers.js";

const cfg = loadConfig();
mkdirSync(cfg.dataDir, { recursive: true });
const db = new Db(`${cfg.dataDir}/overseer.db`);
const core = new Core(cfg, db, new Secrets(cfg.dataDir, cfg.masterKey));

let guard = createNetworkGuard(core.settings.network);
const sockets = new Set<{ ws: WebSocket; remote: string | undefined }>();
/** Set once shutting down or resetting, so it happens only once. */
let stopping = false;

const app = { core } as App;
app.harnesses = new HarnessHub(app);
app.ui = new UiHub(app);
app.scheduler = new Scheduler(app);
app.overseer = new OverseerAgent(app);
app.helper = new HelperAgent(app);
app.workers = new Workers(app);
app.board = new Board(app);
app.approvals = new Approvals(app);
app.onNetworkChange = () => {
  guard = createNetworkGuard(core.settings.network);
  for (const s of sockets) if (!guard(s.remote)) s.ws.close(1008, "address no longer allowed");
};
app.resetAllData = () => {
  console.log("Removing all data at the operator's request...");
  stopping = true;
  for (const s of sockets) s.ws.close(1012, "overseer restarting");
  // Give the close frames a moment, then wipe and exit before anything else can write.
  setTimeout(() => {
    db.wipe();
    db.close();
    for (const f of DATA_FILES) {
      if (f === "master.key" && cfg.masterKey) continue;
      try {
        rmSync(join(cfg.dataDir, f), { force: true });
      } catch (e) {
        console.warn(`  Couldn't delete ${f} (its contents are already gone): ${(e as Error).message}`);
      }
    }
    console.log(process.env.ALLIANCE_SUPERVISED ? "All data removed. Restarting..." : "All data removed. Start the Overseer again.");
    process.exit(RESTART_EXIT_CODE);
  }, 250);
};
core.broadcast = app.ui.broadcast;

/** The client's address. Forwarded headers are only trusted when trustProxy is on. */
function clientAddress(socket: Socket, headers: Record<string, string | string[] | undefined>): string | undefined {
  if (core.settings.network.trustProxy) {
    const fwd = headers["x-forwarded-for"];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return socket.remoteAddress;
}

let lastRejectEvent = 0;
function rejected(remote: string | undefined, what: string): void {
  if (Date.now() - lastRejectEvent < 10_000) return; // rate-limit the event
  lastRejectEvent = Date.now();
  core.event("warn", { kind: "overseer", id: "network" }, "network.rejected", `Rejected ${what} from ${remote ?? "unknown"} (public access is off)`);
}

const http = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });
http.addHook("onRequest", async (req, reply) => {
  const remote = clientAddress(req.raw.socket, req.headers);
  if (!guard(remote)) {
    rejected(remote, `${req.method} ${req.url.split("?")[0]}`);
    return reply.code(403).type("text/plain").send("Forbidden: this Overseer only accepts connections from private networks.");
  }
});
registerRoutes(http, app);

http.server.on("upgrade", (req, socket: Socket, head) => {
  const remote = clientAddress(socket, req.headers);
  const path = (req.url ?? "").split("?")[0];
  const hub = path === "/ws/ui" ? app.ui.wss : path === "/ws/harness" ? app.harnesses.wss : undefined;
  if (!guard(remote) || !hub) {
    if (!guard(remote)) rejected(remote, `WebSocket ${path}`);
    socket.write(`HTTP/1.1 ${hub ? "403 Forbidden" : "404 Not Found"}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
    return;
  }
  hub.handleUpgrade(req, socket, head, (ws) => {
    const entry = { ws, remote };
    sockets.add(entry);
    ws.on("close", () => sockets.delete(entry));
    hub.emit("connection", ws, req);
  });
});

// -- metrics (every 5 s) ------------------------------------------------------------------
setInterval(() => {
  const now = Date.now();
  const lastMin = core.usage.filter((u) => u.ts > now - 60_000);
  const recent = core.events.filter((e) => new Date(e.ts).getTime() > now - 5 * 60_000);
  const latencies = lastMin.map((u) => u.durationMs).filter((d) => d > 0).sort((a, b) => a - b);
  const agents = core.liveAgents();
  const m: MetricsSnapshot = {
    ts: nowIso(),
    agentsOnline: agents.filter((a) => a.status !== "offline").length,
    agentsTotal: agents.length,
    runsActive: [...core.runs.values()].filter((r) => ["assigned", "running", "waiting_approval", "paused"].includes(r.status)).length,
    tasksQueued: [...core.tasks.values()].filter((t) => t.status === "queued").length,
    tokensPerMin: lastMin.reduce((n, u) => n + u.inputTokens + u.outputTokens, 0),
    costTodayUsd: 0, // provider pricing isn't configured yet
    errorRate: recent.length ? recent.filter((e) => e.level === "error").length / recent.length : 0,
    p50LatencyMs: latencies.length ? latencies[Math.floor(latencies.length / 2)]! : 0,
  };
  core.metrics.push(m);
  if (core.metrics.length > 120) core.metrics.shift();
  core.broadcast(envelope("metrics", m));
}, 5000).unref();
setInterval(() => db.pruneEvents(), 6 * 60 * 60 * 1000).unref();

// -- push updates when the harness code changes on disk -------------------------------------
let watchTimer: NodeJS.Timeout | undefined;
try {
  watch(cfg.harnessDir, { recursive: true }, (_e, file) => {
    if (!file || !/\.py$|requirements\.txt$/.test(String(file)) || String(file).includes("__pycache__")) return;
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => app.harnesses.checkUpdates(), 2000);
  });
} catch {
  /* recursive watch unsupported: updates are still checked when harnesses connect */
}

await http.listen({ port: cfg.port, host: cfg.bindHost });
const urls = core.advertisedUrls();
console.log(`United Alliance Overseer listening on ${cfg.bindHost}:${cfg.port}`);
console.log(`  Console:          http://localhost:${cfg.port}`);
console.log(`  For harnesses:    ${urls.join("  ")}`);
console.log(`  Public access:    ${core.settings.network.allowPublic ? "ON" : "off (private networks only)"}`);
console.log(`  Data:             ${cfg.dataDir}`);
console.log(`  Harness version:  ${core.harnessSources().hash.slice(0, 12)}`);
core.event("info", { kind: "overseer", id: "overseer" }, "overseer.started", `Overseer started on port ${cfg.port}`);

const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await http.close().catch(() => undefined);
  db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
