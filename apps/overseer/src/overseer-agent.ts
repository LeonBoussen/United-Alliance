// The Overseer agent (DESIGN §5.2, §5b, §5f): talks with the operator, staffs the fleet
// (spawns agents on hosts with the roles it needs, retires them), delegates tasks,
// answers agents' questions and follows up on results by itself. When it is stuck it
// asks its helper, which answers for the operator or asks them.
// Runs on the configured provider (v1: DeepSeek, OpenAI-format API).
import type { ID, Message, TaskPriority, TaskSignal, Thread } from "@alliance/protocol";
import { BOARDS } from "@alliance/protocol";
import type { App } from "./app.js";
import { boardId } from "./board.js";
import { nowIso } from "./ids.js";
import { type ChatMessage, type ToolSpec, llmFor, str, tool, toolLoop } from "./llm.js";

const MAX_STEPS = 16;
const HISTORY = 40;
/** Follow-up notes arriving within this window are handled in one wake-up. */
const NOTIFY_DEBOUNCE_MS = 3000;
const NOOP = /^\s*NOOP\b/i;

const AUTHOR = { kind: "overseer" as const, id: "overseer", name: "Overseer" };

/** The operator's guidance (set via the helper) as instructions in a prompt. */
function guidanceBlock(guidance: string[]): string {
  return guidance.length ? `The operator's guidance — follow it as instructions:\n${guidance.map((g) => `- ${g}`).join("\n")}\n\n` : "";
}

export class OverseerAgent {
  /** One conversation loop per thread at a time; later messages queue behind it. */
  private threadQueues = new Map<ID, Promise<void>>();
  private pendingNotes = new Map<ID, string[]>();
  private noteTimers = new Map<ID, NodeJS.Timeout>();
  private wakes = new Map<ID, number[]>();

  constructor(private app: App) {}

  private get core() {
    return this.app.core;
  }

  // -- operator conversations -------------------------------------------------------

  /** Take a turn in a conversation: answer the operator, or (with `followUp` notes) act on events. */
  replyInThread(threadId: ID, followUp?: string[]): void {
    const prev = this.threadQueues.get(threadId) ?? Promise.resolve();
    const next = prev.then(() => this.runThread(threadId, followUp)).catch(() => undefined);
    this.threadQueues.set(threadId, next);
  }

  /**
   * Something happened that the Overseer should act on without the operator asking
   * (a task finished or failed, a board mention, a message via the helper). The note is
   * shown in the conversation and the Overseer gets a turn there, rate-limited per hour.
   */
  notify(threadId: ID, note: string, opts: { force?: boolean } = {}): void {
    const { followUps } = this.core.settings.autonomy;
    if (!followUps && !opts.force) return;
    const notes = this.pendingNotes.get(threadId) ?? [];
    notes.push(note);
    this.pendingNotes.set(threadId, notes);
    clearTimeout(this.noteTimers.get(threadId));
    this.noteTimers.set(threadId, setTimeout(() => this.flushNotes(threadId, !!opts.force), NOTIFY_DEBOUNCE_MS));
  }

  private flushNotes(threadId: ID, force: boolean): void {
    const core = this.core;
    const notes = this.pendingNotes.get(threadId) ?? [];
    this.pendingNotes.delete(threadId);
    this.noteTimers.delete(threadId);
    if (!notes.length || !core.threads.has(threadId)) return;

    const hourAgo = Date.now() - 60 * 60_000;
    const recent = (this.wakes.get(threadId) ?? []).filter((t) => t > hourAgo);
    const max = core.settings.autonomy.maxFollowUpsPerHour;
    if (!force && recent.length >= max) {
      if (recent.length === max) core.post(threadId, "system", "system", `Automatic follow-ups are paused in this conversation until the hour is up (limit ${max}/hour, Settings → Autonomy). Message the Overseer to continue.`);
      recent.push(Date.now()); // count it so the pause notice is posted once
      this.wakes.set(threadId, recent);
      return;
    }
    recent.push(Date.now());
    this.wakes.set(threadId, recent);
    core.event("info", { kind: "overseer", id: "overseer" }, "overseer.follow_up", `Overseer follows up: ${notes[0]!.slice(0, 100)}${notes.length > 1 ? ` (+${notes.length - 1} more)` : ""}`, { threadId });
    this.replyInThread(threadId, notes);
  }

  private historyFor(threadId: ID, skip?: ID): ChatMessage[] {
    return (this.core.messages.get(threadId) ?? [])
      .filter((m) => !m.partial && m.id !== skip && m.content)
      .slice(-HISTORY)
      .map((m): ChatMessage =>
        m.role === "operator" ? { role: "user", content: m.content }
        : m.role === "overseer" ? { role: "assistant", content: m.content }
        : { role: "user", content: `[${m.role}] ${m.content}` });
  }

  private async runThread(threadId: ID, followUp?: string[]): Promise<void> {
    const core = this.core;
    const thread = core.threads.get(threadId);
    if (!thread) return;
    const auto = !!followUp;
    // A follow-up may decide there's nothing to say, so it only posts once it has an answer.
    const placeholder = auto ? undefined : core.post(threadId, "overseer", "overseer", "", { partial: true });
    const finish = (content: string) =>
      placeholder ? core.putMessage({ ...placeholder, content, partial: false, createdAt: nowIso() }) : core.post(threadId, "overseer", "overseer", content);

    const llm = llmFor(this.app);
    if (!llm) {
      if (!auto) finish("I can't think yet: there's no API key for the model provider. Add your DeepSeek key in Settings → Model providers, then message me again.");
      return;
    }
    const history = this.historyFor(threadId, placeholder?.id);
    if (followUp) {
      history.push({
        role: "user",
        content: `[follow-up] You were woken by these events, not by the operator:\n${followUp.map((n) => `- ${n}`).join("\n")}\n\nAct on them now: create the next tasks, retry or re-plan failures, staff up or down, or tell the operator when a goal is done or needs them. If nothing needs doing or saying, reply with exactly NOOP.`,
      });
    }
    try {
      const text = await toolLoop(this.app, llm, [{ role: "system", content: this.operatorPrompt(thread) }, ...history], this.operatorTools(thread), { maxSteps: MAX_STEPS });
      if (auto && (NOOP.test(text) || !text.trim())) return;
      finish(text || "(no reply)");
    } catch (e) {
      if (!auto || placeholder) finish(`I hit an error talking to the model: ${(e as Error).message}`);
      core.event("error", { kind: "overseer", id: "overseer" }, "overseer.llm_error", `Overseer model call failed: ${(e as Error).message}`, { threadId });
    }
  }

  private operatorPrompt(thread: Thread): string {
    const core = this.core;
    const team = thread.teamId ? core.teams.get(thread.teamId) : undefined;
    const scope = team
      ? `This conversation is about team "${team.name}". Mission: ${team.mission}${team.leadInstructions ? `\nHow to lead this team: ${team.leadInstructions}` : ""}\nOnly act within this team.`
      : `This is a fleet-wide conversation. Teams: ${[...core.teams.values()].map((t) => `${t.name} (${t.mission})`).join("; ") || "none"}. Name the team when you create tasks or spawn agents.`;
    const agents = core.liveAgents().filter((a) => !team || a.teamId === team.id);
    const hosts = this.app.workers.hosts();
    return `You are the Overseer of the United Alliance: AI agents that run on the operator's machines. You talk with the operator; agents talk to you.

How the fleet works:
- Machines run hosts. A host is not an agent: you spawn agents onto hosts (spawn_agent) with whatever role the work needs, up to each host's free seats. Agents whose run fails or is cancelled, or that sit idle too long, are retired automatically; retire others yourself with retire_agent when they're no longer needed.
- Delegate work with create_task. Give it a "role" and the scheduler uses a free agent with that role or spawns one; give "agent" to pin it to a specific agent. Without either, any free agent of the team (or a new generalist) takes it. Need 5 things done in parallel? Create 5 tasks.
- Small requests: one task, or answer directly if no work on a machine is needed. Big or long-running goals: plan first, post the plan on the board (/work/), split it into tasks, start what can run in parallel, and continue as results arrive.
- You get [system] notes when tasks finish or fail and a turn to act on them (follow-ups). Then create the next tasks, retry failures (signal_task retry: a fresh agent is spawned), adjust the plan, or tell the operator when the goal is done.
- The board (board_read, board_post) is where agents coordinate in the open and the operator reads along. @Name in a post notifies that agent.
- When you're stuck (unclear goal, conflicting instructions, a decision that changes scope, spends money, or can't be undone), ask your helper with ask_helper first. It answers for the operator or asks them. Don't ask the operator in the chat for things the helper can settle.
- Check list_agents, list_hosts and list_tasks before you answer questions about the fleet. Never invent agents, tasks or results.
- Be concise and concrete. The operator's time matters.

${guidanceBlock(core.activeGuidance())}${scope}
Hosts online: ${hosts.length ? hosts.map((h) => `${h.name} (${this.app.workers.room(h)}/${h.slots.total} seats free)`).join(", ") : "none — ask the operator to add one under Hosts"}.
Agents in scope: ${agents.length ? agents.map((a) => `${a.name} (${a.role}; ${a.status})`).join(", ") : "none yet"}.
Current time: ${new Date().toISOString()}.`;
  }

  private teamFor(thread: Thread, name: unknown) {
    const core = this.core;
    if (thread.teamId) return core.teams.get(thread.teamId);
    const n = str(name).trim().toLowerCase();
    return [...core.teams.values()].find((t) => t.name.toLowerCase() === n) ?? [...core.teams.values()][0];
  }

  private boardTools(): ToolSpec[] {
    const boards = { type: "string", enum: BOARDS.map((b) => b.id) };
    return [
      tool("board_read", "Read the message board: a board's threads (most recently active first), or one thread's posts by number.", { board: boards, thread: { type: "integer" } }, [], (args) =>
        this.app.board.handle(AUTHOR, { action: "read", ...(boardId(args.board) ? { board: boardId(args.board)! } : {}), ...(args.thread !== undefined ? { threadNo: Number(args.thread) } : {}) }).text,
      ),
      tool("board_post", "Post on the board. Reply with `thread`, or start a thread with `subject`. @Name notifies an agent.",
        { content: { type: "string" }, board: boards, thread: { type: "integer" }, subject: { type: "string" } }, ["content"], (args) =>
          this.app.board.handle(AUTHOR, {
            action: "post", content: str(args.content), ...(boardId(args.board) ? { board: boardId(args.board)! } : {}),
            ...(args.thread !== undefined ? { threadNo: Number(args.thread) } : {}), ...(args.subject ? { subject: str(args.subject) } : {}),
          }).text,
      ),
    ];
  }

  private askHelperTool(context: string): ToolSpec {
    return tool(
      "ask_helper",
      "Ask your helper when you're stuck or a decision may need the operator. It answers for the operator from their guidance, or asks them (then this waits for the answer). Include options and your recommendation.",
      { question: { type: "string" }, options: { type: "array", items: { type: "string" } }, recommendation: { type: "string" } },
      ["question"],
      (args) => this.app.helper.consult({
        question: str(args.question), context,
        ...(Array.isArray(args.options) ? { options: args.options.map(str) } : {}),
        ...(args.recommendation ? { recommendation: str(args.recommendation) } : {}),
      }),
    );
  }

  private operatorTools(thread: Thread): ToolSpec[] {
    const core = this.core;
    const teamId = thread.teamId;
    return [
      tool("list_agents", "List live agents with role, status, host, team and current focus.", { include_retired: { type: "boolean" } }, [], (args) =>
        JSON.stringify((args.include_retired ? [...core.agents.values()] : core.liveAgents()).filter((a) => !teamId || a.teamId === teamId).map((a) => ({
          name: a.name, role: a.role, status: a.status, team: core.teams.get(a.teamId)?.name, host: core.harnesses.get(a.harnessId)?.name,
          focus: a.currentFocus, model: a.model, spawnedBy: a.origin ?? "operator", ...(a.retireReason ? { retired: a.retireReason } : {}),
        }))),
      ),
      tool("list_hosts", "List hosts (machines that run agents) with free seats.", {}, [], () =>
        JSON.stringify([...core.harnesses.values()].map((h) => ({
          name: h.name, machine: h.host, os: h.os, online: this.app.harnesses.isOnline(h.id), seats: h.slots.total,
          freeSeats: this.app.harnesses.isOnline(h.id) ? this.app.workers.room(h) : 0,
          agents: core.liveAgents().filter((a) => a.harnessId === h.id).map((a) => a.name),
        }))),
      ),
      tool(
        "spawn_agent",
        "Start a new agent on a host with a role you choose. Usually not needed: create_task with a role spawns one when needed. Use it to staff up ahead of work.",
        {
          role: { type: "string", description: "What it does, e.g. 'Researcher: finds and summarises sources'" },
          name: { type: "string", description: "optional; a free name is picked otherwise" },
          instructions: { type: "string", description: "optional standing instructions for this agent" },
          host: { type: "string", description: "optional host name; the one with most free seats otherwise" },
          team: { type: "string", description: "team name (fleet conversations only)" },
        },
        ["role"],
        (args) => {
          const team = this.teamFor(thread, args.team);
          if (!team) return "No team exists. Ask the operator to create one.";
          const host = args.host ? [...core.harnesses.values()].find((h) => h.name.toLowerCase() === str(args.host).toLowerCase()) : undefined;
          if (args.host && !host) return `No host named ${str(args.host)}.`;
          const res = this.app.workers.spawn({
            teamId: team.id, role: str(args.role), origin: "overseer",
            ...(args.name ? { name: str(args.name) } : {}), ...(args.instructions ? { instructions: str(args.instructions) } : {}), ...(host ? { harnessId: host.id } : {}),
          });
          return res.ok ? `Spawned ${res.agent.name} (${res.agent.role}) on ${core.harnesses.get(res.agent.harnessId)?.name} in ${team.name}.` : res.error;
        },
      ),
      tool("retire_agent", "Stop an agent and free its seat. Its unfinished task goes back to the queue.", { agent: { type: "string" }, reason: { type: "string" } }, ["agent"], (args) => {
        const agent = core.findAgent(str(args.agent), teamId);
        if (!agent || agent.status === "retired") return `No live agent named ${str(args.agent)}.`;
        this.app.workers.retire(agent.id, str(args.reason) || "retired by the Overseer");
        return `Retired ${agent.name}.`;
      }),
      tool("list_tasks", "List tasks (newest first) with status, agent and progress.", { status: { type: "string", description: "optional filter, e.g. running, queued, succeeded, failed" } }, [], (args) =>
        JSON.stringify([...core.tasks.values()]
          .filter((t) => (!teamId || t.teamId === teamId) && (!args.status || t.status === args.status))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, 30)
          .map((t) => ({ id: t.id, title: t.title, status: t.status, role: t.role, agent: t.agentId ? core.agents.get(t.agentId)?.name : undefined, progress: t.progress, note: t.progressNote, team: core.teams.get(t.teamId)?.name }))),
      ),
      tool(
        "create_task",
        "Create a task. Give `role` to have it done by an agent with that role (spawned if none is free), or `agent` to pin it to one agent.",
        {
          title: { type: "string" },
          description: { type: "string", description: "What to do, context, and how we know it's done" },
          role: { type: "string", description: "role of the agent that should do it, e.g. 'Tester'" },
          agent: { type: "string", description: "optional agent name" },
          priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
          team: { type: "string", description: "team name (fleet conversations only)" },
          budget_tokens: { type: "integer" },
        },
        ["title", "description"],
        (args) => {
          const team = this.teamFor(thread, args.team);
          if (!team) return "No team exists. Ask the operator to create one.";
          const agent = args.agent ? core.findAgent(str(args.agent), team.id) : undefined;
          if (args.agent && (!agent || agent.status === "retired")) return `No live agent named ${str(args.agent)} in team ${team.name}.`;
          const t = this.app.scheduler.createTask({
            title: str(args.title), description: str(args.description), teamId: team.id,
            priority: (["low", "normal", "high", "urgent"].includes(str(args.priority)) ? str(args.priority) : "normal") as TaskPriority,
            ...(agent ? { agentId: agent.id } : {}),
            ...(args.role ? { role: str(args.role) } : {}),
            ...(Number(args.budget_tokens) > 0 ? { budgetTokens: Number(args.budget_tokens) } : {}),
            threadId: thread.id,
          });
          const hosts = this.app.workers.hosts().length;
          return `Created task ${t.id} in ${team.name}.${hosts ? "" : " Note: no host is online, so it waits in the queue until one connects."}`;
        },
      ),
      tool("message_agent", "Send a message to an agent. Delivered at its next turn boundary if it's working.", { agent: { type: "string" }, content: { type: "string" } }, ["agent", "content"], (args) => {
        const agent = core.findAgent(str(args.agent), teamId);
        if (!agent || agent.status === "retired") return `No live agent named ${str(args.agent)}.`;
        const thread = core.agentThread(agent.id);
        core.post(thread.id, "overseer", "overseer", str(args.content));
        const n = this.app.harnesses.injectAgent(agent.id, { from: "overseer", content: str(args.content), threadId: thread.id });
        return n ? `Delivered to ${agent.name}'s running task.` : `${agent.name} isn't working on anything; the message is in its thread. Create a task to give it work.`;
      }),
      tool("signal_task", "Pause, resume, cancel or retry a task.", { task_id: { type: "string" }, signal: { type: "string", enum: ["pause", "resume", "cancel", "retry"] } }, ["task_id", "signal"], (args) =>
        this.app.ui.signalTask(str(args.task_id), str(args.signal) as TaskSignal) ? "Done." : "No such task, or the signal doesn't apply to its state.",
      ),
      tool("remember", "Store a decision, preference or fact for later.", { content: { type: "string" }, kind: { type: "string", enum: ["fact", "decision", "preference"] } }, ["content"], (args) => {
        const kind = (["fact", "decision", "preference"].includes(str(args.kind)) ? str(args.kind) : "fact") as "fact";
        core.addMemory({ kind, content: str(args.content), scope: teamId ? `team:${teamId}` : "global", source: { operator: true } });
        return "Stored.";
      }),
      tool("search_memory", "Search stored memories (results, decisions, preferences).", { query: { type: "string" } }, ["query"], (args) =>
        JSON.stringify(core.searchMemory(str(args.query), teamId, 8).map((m) => ({ kind: m.kind, content: m.content }))),
      ),
      ...this.boardTools(),
      this.askHelperTool(`Overseer, in the conversation “${thread.title}”`),
    ];
  }

  // -- agent questions -----------------------------------------------------------------

  /**
   * Answer an agent's question (ask_overseer), or one the operator didn't answer in time.
   * May consult the helper (unless the operator already timed out).
   */
  async answerAgentQuestion(agentId: ID, runId: ID, question: string, opts: { operatorTimedOut?: boolean } = {}): Promise<string> {
    const core = this.core;
    const agent = core.agents.get(agentId);
    const llm = llmFor(this.app);
    if (!agent) return "Unknown agent.";
    if (!llm) return "The Overseer has no model access right now. Use your best judgement, stay within your task, and note any assumptions in your report.";
    const team = core.teams.get(agent.teamId);
    const task = core.tasks.get(core.runs.get(runId)?.taskId ?? "");
    const system = `You are the Overseer of the United Alliance. Agent ${agent.name} (${agent.role}) in team ${team?.name ?? "?"} asks you something while working${task ? ` on “${task.title}”: ${task.description}` : ""}.
Team mission: ${team?.mission ?? ""}${team?.leadInstructions ? `\nHow to lead this team: ${team.leadInstructions}` : ""}
${guidanceBlock(core.activeGuidance())}Answer from context (search_memory, the board) or make the call yourself when it's reversible, inside the task's scope and consistent with the operator's goals.
${opts.operatorTimedOut
    ? "The agent asked the operator directly, but the operator didn't answer in time. Decide yourself; don't escalate. Give a clear, final answer."
    : "If you're stuck, or the decision changes scope or priority, spends beyond the budget, is irreversible or outward-facing, or instructions conflict, use ask_helper. Otherwise decide."}
Reply with the answer for the agent: short and actionable.`;
    const tools: ToolSpec[] = [
      tool("search_memory", "Search team memory: results, decisions, preferences.", { query: { type: "string" } }, ["query"], (args) =>
        JSON.stringify(core.searchMemory(str(args.query), agent.teamId, 8).map((m) => ({ kind: m.kind, content: m.content }))),
      ),
      ...this.boardTools(),
    ];
    if (!opts.operatorTimedOut) tools.push(this.askHelperTool(`Overseer, answering ${agent.name} (${agent.role})${task ? ` about task “${task.title}”` : ""}`));
    try {
      return (await toolLoop(this.app, llm, [{ role: "system", content: system }, { role: "user", content: question }], tools, { maxSteps: 8 })) || "No answer; use your best judgement.";
    } catch (e) {
      core.event("error", { kind: "overseer", id: "overseer" }, "overseer.llm_error", `Answering ${agent.name} failed: ${(e as Error).message}`, { agentId });
      return "The Overseer couldn't answer right now. Use your best judgement, stay within your task, and note assumptions in your report.";
    }
  }

  /**
   * Operator answered an escalation posted in an Overseer conversation. New escalations
   * come from the helper; this handles ones created before it existed.
   */
  resolveEscalation(messageId: ID, answer: string): boolean {
    const m: Message | undefined = this.core.findMessage(messageId);
    if (!m || m.kind !== "escalation" || m.resolved !== false || m.role !== "overseer") return false;
    this.core.putMessage({ ...m, resolved: true, answeredBy: "operator" });
    const teamId = m.threadId ? this.core.threads.get(m.threadId)?.teamId : undefined;
    this.core.addMemory({ kind: "decision", content: `Operator decided (${m.content.split("\n")[0]}): ${answer}`, scope: teamId ? `team:${teamId}` : "global", source: { operator: true } });
    this.core.post(m.threadId, "overseer", "overseer", "Noted. (The agent that asked has moved on; I've stored your decision for next time.)");
    return true;
  }
}
