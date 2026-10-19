import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Approval, ID, Risk } from "@alliance/protocol";
import type { App } from "./app.js";
import { Approvals, parseVerdict } from "./approvals.js";
import { Board, mentions } from "./board.js";
import { loadConfig } from "./config.js";
import { Core } from "./core.js";
import { Db } from "./db.js";
import { fitHistory, type ChatMessage } from "./llm.js";
import { Scheduler } from "./scheduler.js";
import { Secrets } from "./secrets.js";
import { Workers } from "./workers.js";

/** Real state, scheduler, workers and board; the harness channel and the LLM agents are stubs. */
function fleet(slots: number) {
  const dir = mkdtempSync(join(tmpdir(), "ua-test-"));
  const core = new Core(loadConfig({ ALLIANCE_DATA_DIR: dir }), new Db(":memory:"), new Secrets(dir));
  const sent: { harnessId: ID; type: string; payload: unknown }[] = [];
  const injected: { agentId: ID; content: string }[] = [];
  const notes: string[] = [];
  const app = { core } as App;
  app.harnesses = {
    isOnline: (id: ID) => id === "hrn_1",
    send: (harnessId: ID, type: string, payload: unknown) => (sent.push({ harnessId, type, payload }), true),
    pushAgents: (harnessId: ID) => void sent.push({ harnessId, type: "agents.update", payload: null }),
    assign: () => true,
    injectAgent: (agentId: ID, p: { content: string }) => (injected.push({ agentId, content: p.content }), 1),
  } as unknown as App["harnesses"];
  app.overseer = { notify: (_t: ID, note: string) => void notes.push(note) } as unknown as App["overseer"];
  app.scheduler = new Scheduler(app);
  app.workers = new Workers(app);
  app.board = new Board(app);
  core.upsert("harness", { id: "hrn_1", name: "atlas", host: "atlas", version: "1", status: "online", capabilities: [], slots: { total: slots, used: 0 }, lastHeartbeatAt: new Date().toISOString() });
  const team = [...core.teams.values()][0]!;
  const assignNow = () => (app.scheduler as unknown as { assign(): void }).assign();
  return { core, app, team, sent, injected, notes, assignNow };
}

test("queued tasks spawn agents with the requested role, up to the host's seats", () => {
  const { core, app, team, assignNow } = fleet(2);
  for (const n of [1, 2, 3]) app.scheduler.createTask({ title: `Research ${n}`, description: "", priority: "normal", teamId: team.id, role: "Researcher" });
  assignNow();
  const live = core.liveAgents();
  assert.equal(live.length, 2);
  assert.ok(live.every((a) => a.role === "Researcher" && a.origin === "overseer" && a.harnessId === "hrn_1"));
  assert.equal(new Set(live.map((a) => a.name)).size, 2);
  const statuses = [...core.tasks.values()].map((t) => t.status).sort();
  assert.deepEqual(statuses, ["assigned", "assigned", "queued"]);
});

test("retiring an agent requeues its task unpinned and frees the seat for a new one", () => {
  const { core, app, team, sent, assignNow } = fleet(1);
  const task = app.scheduler.createTask({ title: "Build it", description: "", priority: "normal", teamId: team.id });
  assignNow();
  const first = core.liveAgents()[0]!;
  assert.equal(core.tasks.get(task.id)!.agentId, first.id);

  app.workers.retire(first.id, "test");
  assert.equal(core.agents.get(first.id)!.status, "retired");
  assert.ok(sent.some((m) => m.type === "run.signal"));
  const requeued = core.tasks.get(task.id)!;
  assert.equal(requeued.status, "queued");
  assert.equal(requeued.agentId, undefined);

  assignNow();
  const second = core.liveAgents()[0]!;
  assert.notEqual(second.id, first.id);
  assert.equal(core.tasks.get(task.id)!.agentId, second.id);
});

test("an idle spawned agent is retired to make room when the host is full", () => {
  const { core, app, team } = fleet(1);
  const idle = app.workers.spawn({ teamId: team.id, role: "Writer", origin: "overseer" });
  assert.ok(idle.ok);
  const next = app.workers.spawn({ teamId: team.id, role: "Tester", origin: "overseer" });
  assert.ok(next.ok);
  assert.equal(core.agents.get(idle.ok ? idle.agent.id : "")!.status, "retired");
  // Operator-spawned agents are not evicted.
  const pinned = fleet(1);
  assert.ok(pinned.app.workers.spawn({ teamId: pinned.team.id, role: "Keeper", origin: "operator" }).ok);
  assert.equal(pinned.app.workers.spawn({ teamId: pinned.team.id, role: "Tester", origin: "overseer" }).ok, false);
});

test("board: threads, replies by number, and @mentions reach the agent", () => {
  const { app, team, injected } = fleet(2);
  const scout = app.workers.spawn({ teamId: team.id, role: "Researcher", name: "Scout", origin: "overseer" });
  assert.ok(scout.ok);
  const op = app.board.post({ kind: "overseer", id: "overseer", name: "Overseer" }, { board: "work", subject: "Plan", content: "Step 1 is research." });
  assert.ok(op.ok && op.post.no === op.thread.no);
  const reply = app.board.handle({ kind: "operator", id: "op", name: "Operator" }, { action: "post", threadNo: op.ok ? op.thread.no : 0, content: "@Scout please start" });
  assert.ok(reply.ok, reply.text);
  assert.equal(injected.length, 1);
  assert.match(injected[0]!.content, /please start/);
  const read = app.board.handle({ kind: "agent", id: "x", name: "X" }, { action: "read", board: "work" });
  assert.match(read.text, /“Plan” by Overseer · 1 reply/);
  assert.deepEqual(mentions("hi @Scout and @Forge-2, not email@host"), ["Scout", "Forge-2"]);
});

test("fitHistory keeps the system prompt and newest messages within the budget", () => {
  const msgs: ChatMessage[] = [{ role: "system", content: "rules" }];
  for (let i = 0; i < 50; i++) msgs.push({ role: i % 2 ? "assistant" : "user", content: `${i} ${"x".repeat(1000)}` });
  const fit = fitHistory(msgs, 10_000);
  assert.equal(fit[0]!.content, "rules");
  assert.match(String(fit[1]!.content), /omitted/);
  assert.equal(fit.at(-1), msgs.at(-1));
  assert.ok(fit.length < 15);
});

test("approvals: verdict parsing", () => {
  assert.deepEqual(parseVerdict("APPROVE: runs the test suite, in scope"), { verdict: "approve", reason: "runs the test suite, in scope" });
  assert.equal(parseVerdict("**DENY** - deletes the repo").verdict, "deny");
  assert.equal(parseVerdict("Hmm, hard to say").verdict, "unsure");
});

test("approvals follow the route for the risk: auto, overseer → helper → operator, per-agent override", async () => {
  const { core, app, team } = fleet(2);
  const decided: { id: string; approved: boolean; by: string }[] = [];
  (app.harnesses as unknown as Record<string, unknown>).resolveApproval = (id: string, approved: boolean, _note: string, by = "operator") => {
    decided.push({ id, approved, by });
    const a = core.approvals.get(id)!;
    core.upsert("approval", { ...a, status: approved ? "approved" : "denied" });
    return true;
  };
  app.approvals = new Approvals(app);
  const spawned = app.workers.spawn({ teamId: team.id, role: "Builder", origin: "overseer" });
  assert.ok(spawned.ok);
  const agentId = spawned.ok ? spawned.agent.id : "";
  const request = (id: string, risk: Risk) => {
    const a: Approval = { id, runId: "run_x", taskId: "tsk_x", agentId, toolName: "shell", input: { command: "ls" }, reason: "", risk, status: "pending", stage: "overseer", createdAt: new Date().toISOString() };
    core.upsert("approval", a);
    return app.approvals.start(a);
  };

  await request("apr_low", "low"); // default route: approve
  assert.deepEqual(decided, [{ id: "apr_low", approved: true, by: "policy" }]);

  await request("apr_med", "medium"); // Overseer, then helper; no model here, so both are unsure
  const med = core.approvals.get("apr_med")!;
  assert.equal(med.stage, "operator");
  assert.equal(med.reviewNotes?.length, 2);
  assert.equal(decided.length, 1);

  core.saveAgentDef({ ...core.agentDefs.get(agentId)!, approvals: { medium: "approve" }, tools: [{ name: "shell", policy: "ask", risk: "high" }] });
  assert.equal(app.approvals.riskFor(agentId, "shell", "medium"), "high");
  assert.equal(app.approvals.routeFor(agentId, "medium"), "approve");
  assert.equal(app.approvals.routeFor(agentId, "high"), "overseer");
});
