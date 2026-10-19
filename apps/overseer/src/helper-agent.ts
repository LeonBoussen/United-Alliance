// The Overseer's helper (DESIGN §5d). It stands between the Overseer and the operator:
// when the Overseer is stuck it asks the helper first, and the helper answers in the
// operator's place from the operator's guidance (standing instructions set in the
// Helper chat) and stored decisions. Only what that doesn't cover goes to the operator,
// as an escalation in the Helper chat. The operator also uses the chat to tell the
// helper what to do and say, and the helper can pass messages on to the Overseer.
import type { ID, Message } from "@alliance/protocol";
import type { App } from "./app.js";
import { nowIso, newId } from "./ids.js";
import { type ChatMessage, type ToolSpec, llmFor, str, tool, toolLoop } from "./llm.js";

const MAX_STEPS = 8;
const HISTORY = 30;

export interface Consultation {
  question: string;
  /** Who is stuck and on what, e.g. "Overseer, while answering Scout about task X". */
  context?: string;
  options?: string[];
  recommendation?: string;
}

export class HelperAgent {
  private queue: Promise<void> = Promise.resolve();
  private escalations = new Map<ID, (answer: string) => void>();

  constructor(private app: App) {}

  private get core() {
    return this.app.core;
  }

  private guidanceText(): string {
    const items = [...this.core.guidance.values()].filter((g) => !g.removed);
    return items.length ? items.map((g) => `- [${g.id}] ${g.content}`).join("\n") : "(none yet)";
  }

  private baseTools(): ToolSpec[] {
    const core = this.core;
    return [
      tool("search_memory", "Search stored decisions, preferences and results.", { query: { type: "string" } }, ["query"], (args) =>
        JSON.stringify(core.searchMemory(str(args.query), undefined, 8).map((m) => ({ kind: m.kind, content: m.content }))),
      ),
      tool("board_read", "Read the message board: a board's threads, or one thread by number.", { board: { type: "string" }, thread: { type: "integer" } }, [], (args) =>
        this.app.board.handle({ kind: "helper", id: "helper", name: "Helper" }, {
          action: "read", ...(args.board ? { board: str(args.board) as "general" } : {}), ...(args.thread !== undefined ? { threadNo: Number(args.thread) } : {}),
        }).text,
      ),
    ];
  }

  // -- the Overseer asks -------------------------------------------------------------------

  /** Answer a question from the Overseer, asking the operator only if the guidance doesn't cover it. */
  async consult(c: Consultation): Promise<string> {
    const core = this.core;
    const thread = core.helperThread();
    const asked = [c.question, c.options?.length ? `Options: ${c.options.join(" / ")}` : "", c.recommendation ? `Overseer recommends: ${c.recommendation}` : ""]
      .filter(Boolean)
      .join("\n");
    core.post(thread.id, "overseer", "overseer", `${c.context ? `(${c.context})\n` : ""}${asked}`);

    const llm = llmFor(this.app);
    if (!llm) {
      // No model: pass the question straight to the operator.
      const answer = await this.askOperator(c.question, c.options ?? [], c.recommendation ?? "");
      core.post(thread.id, "helper", "helper", answer);
      return answer;
    }
    const system = `You are the Overseer's helper in the United Alliance, a fleet of AI agents run by an operator (a human). \
You speak for the operator when the operator isn't there. The Overseer (the AI that leads the agents) is stuck and asks you.

Answer it yourself when the operator's guidance, stored decisions or plain good sense for the operator's goals cover it, \
or when the choice is low-stakes and reversible. Call ask_operator only when the decision changes scope or priorities, \
spends real money or more budget than set, is irreversible or outward-facing and not covered by guidance, or the \
guidance conflicts. Ask one clear question with options and your recommendation.

Operator's guidance (standing instructions):
${this.guidanceText()}

Reply with the answer for the Overseer: short, decisive and actionable.`;
    const tools = [
      ...this.baseTools(),
      tool("ask_operator", "Ask the operator directly. Blocks until they answer. Include options and your recommendation.",
        { question: { type: "string" }, options: { type: "array", items: { type: "string" } }, recommendation: { type: "string" } }, ["question"],
        (args) => this.askOperator(str(args.question), Array.isArray(args.options) ? args.options.map(str) : [], str(args.recommendation))),
    ];
    let answer: string;
    try {
      answer = (await toolLoop(this.app, llm, [{ role: "system", content: system }, { role: "user", content: `${c.context ? `Context: ${c.context}\n` : ""}${asked}` }], tools, { maxSteps: MAX_STEPS })) || "No guidance on this; use your best judgement and note the assumption.";
    } catch (e) {
      core.event("error", { kind: "overseer", id: "helper" }, "helper.llm_error", `Helper model call failed: ${(e as Error).message}`);
      answer = "The helper couldn't think right now. Make the most reversible choice and note the assumption.";
    }
    core.post(thread.id, "helper", "helper", answer);
    return answer;
  }

  private askOperator(question: string, options: string[], recommendation: string): Promise<string> {
    const core = this.core;
    const thread = core.helperThread();
    const body = [question, options.length ? `Options:\n${options.map((o, i) => `(${String.fromCharCode(97 + i)}) ${o}`).join("\n")}` : "", recommendation ? `Recommendation: ${recommendation}` : ""]
      .filter(Boolean)
      .join("\n\n");
    const msg = core.post(thread.id, "helper", "helper", body, { kind: "escalation", resolved: false });
    core.event("warn", { kind: "overseer", id: "helper" }, "escalation.created", `The helper asks you: ${question.slice(0, 120)}`, { threadId: thread.id });
    return new Promise((resolve) => this.escalations.set(msg.id, resolve));
  }

  /** The operator answered an escalation in the Helper chat. */
  resolveEscalation(messageId: ID, answer: string): boolean {
    const core = this.core;
    const m: Message | undefined = core.findMessage(messageId);
    if (!m || m.kind !== "escalation" || m.resolved !== false || m.role !== "helper") return false;
    core.putMessage({ ...m, resolved: true, answeredBy: "operator" });
    core.addMemory({ kind: "decision", content: `Operator decided (${m.content.split("\n")[0]}): ${answer}`, scope: "global", source: { operator: true } });
    const resolve = this.escalations.get(messageId);
    this.escalations.delete(messageId);
    resolve?.(`The operator answered: ${answer}`);
    core.post(m.threadId, "helper", "helper", resolve ? "Thanks, passing that on to the Overseer. I've stored it so we don't ask again." : "Noted and stored. (The question had already moved on.)");
    return true;
  }

  // -- the operator talks to the helper ---------------------------------------------------------

  replyInThread(threadId: ID): void {
    this.queue = this.queue.then(() => this.runThread(threadId)).catch(() => undefined);
  }

  private async runThread(threadId: ID): Promise<void> {
    const core = this.core;
    const placeholder = core.post(threadId, "helper", "helper", "", { partial: true });
    const finish = (content: string) => core.putMessage({ ...placeholder, content, partial: false, createdAt: nowIso() });
    const llm = llmFor(this.app);
    if (!llm) return void finish("I can't think yet: there's no API key for the model provider. Add it in Settings → Model providers.");

    const history: ChatMessage[] = (core.messages.get(threadId) ?? [])
      .filter((m) => !m.partial && m.id !== placeholder.id && m.content)
      .slice(-HISTORY)
      .map((m): ChatMessage => m.role === "operator" ? { role: "user", content: m.content } : m.role === "helper" ? { role: "assistant", content: m.content } : { role: "user", content: `[${m.role}] ${m.content}` });
    const system = `You are the Overseer's helper in the United Alliance. In this chat the operator (a human) tells you how to \
handle things while they're away. When the Overseer gets stuck it asks you first, and you answer in the operator's place.

- When the operator states how something should be handled, a preference, a limit or a rule, save it with add_guidance \
(one clear instruction each). Remove guidance that no longer applies.
- When the operator wants something said to or done by the Overseer, pass it on with message_overseer.
- Lines marked [overseer] are the Overseer's questions to you; your earlier answers are yours.
- Be brief. Confirm what you saved or passed on.

Current guidance:
${this.guidanceText()}`;
    const tools = [
      ...this.baseTools(),
      tool("add_guidance", "Save a standing instruction from the operator.", { content: { type: "string" } }, ["content"], (args) => {
        const g = { id: newId("gdn"), content: str(args.content).trim().slice(0, 1000), createdAt: nowIso() };
        if (!g.content) return "Nothing to save.";
        core.upsert("guidance", g);
        return `Saved guidance ${g.id}.`;
      }),
      tool("remove_guidance", "Remove a standing instruction by id.", { id: { type: "string" } }, ["id"], (args) => {
        const g = core.guidance.get(str(args.id));
        if (!g || g.removed) return "No such guidance.";
        core.upsert("guidance", { ...g, removed: true });
        return "Removed.";
      }),
      tool("message_overseer", "Pass a message from the operator on to the Overseer (it reads and acts on it).", { content: { type: "string" } }, ["content"], (args) => {
        const fleet = core.teamThread(undefined);
        core.post(fleet.id, "helper", "helper", str(args.content));
        this.app.overseer.notify(fleet.id, `Message from the operator, via the helper: ${str(args.content)}`, { force: true });
        return "Passed on to the Overseer (fleet conversation).";
      }),
    ];
    try {
      finish((await toolLoop(this.app, llm, [{ role: "system", content: system }, ...history], tools, { maxSteps: MAX_STEPS })) || "(no reply)");
    } catch (e) {
      finish(`I hit an error talking to the model: ${(e as Error).message}`);
    }
  }
}
