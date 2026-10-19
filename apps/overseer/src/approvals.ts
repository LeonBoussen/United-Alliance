// Tool approvals (DESIGN §5b.4). A tool call with policy "ask" is routed by its risk:
// approved automatically, or decided by the Overseer, which hands it to its helper when
// unsure; only when the helper is unsure too does it reach the operator. Both judge by
// the operator's guidance and stored decisions, and answer in one short line.
import type { Agent, Approval, ApprovalRoute, ID, Risk } from "@alliance/protocol";
import type { App } from "./app.js";
import { llmFor, toolLoop } from "./llm.js";

type Verdict = { verdict: "approve" | "deny" | "unsure"; reason: string };

const RISKS: Risk[] = ["low", "medium", "high"];

/** Parse "APPROVE: reason" / "DENY: reason" / "UNSURE: question". Anything else is unsure. */
export function parseVerdict(text: string): Verdict {
  const m = text.trim().match(/^\**\s*(APPROVE|APPROVED|DENY|DENIED|UNSURE)\**\s*[:\-–—]?\s*([\s\S]*)$/i);
  if (!m) return { verdict: "unsure", reason: text.trim().slice(0, 200) || "no clear answer" };
  const word = m[1]!.toUpperCase();
  const reason = m[2]!.trim().split("\n")[0]!.slice(0, 200);
  return { verdict: word.startsWith("APPROVE") ? "approve" : word.startsWith("DEN") ? "deny" : "unsure", reason };
}

export class Approvals {
  constructor(private app: App) {}

  private get core() {
    return this.app.core;
  }

  /** The agent's risk for a tool (its grant can override the harness's built-in risk). */
  riskFor(agentId: ID, toolName: string, reported: Risk): Risk {
    const r = this.core.agentDefs.get(agentId)?.tools.find((t) => t.name === toolName)?.risk;
    return r && RISKS.includes(r) ? r : RISKS.includes(reported) ? reported : "medium";
  }

  routeFor(agentId: ID, risk: Risk): ApprovalRoute {
    return this.core.agentDefs.get(agentId)?.approvals?.[risk] ?? this.core.settings.approvals[risk];
  }

  private pending(id: ID): Approval | undefined {
    const a = this.core.approvals.get(id);
    return a && a.status === "pending" ? a : undefined;
  }

  /** Decide a new approval request along its route. Never throws. */
  async start(approval: Approval): Promise<void> {
    const route = this.routeFor(approval.agentId, approval.risk);
    if (route === "approve") return void this.app.harnesses.resolveApproval(approval.id, true, `auto-approved (${approval.risk} risk)`, "policy");
    if (route === "operator") return this.toOperator(approval.id, []);

    const notes: string[] = [];
    for (const who of ["overseer", "helper"] as const) {
      const a = this.pending(approval.id);
      if (!a) return; // the operator decided meanwhile
      this.core.upsert("approval", { ...a, stage: who, reviewNotes: notes });
      const v = await this.review(who, a, notes);
      if (!this.pending(approval.id)) return;
      if (v.verdict !== "unsure") {
        return void this.app.harnesses.resolveApproval(approval.id, v.verdict === "approve", v.reason, who);
      }
      notes.push(`${who === "overseer" ? "Overseer" : "Helper"}: unsure — ${v.reason}`);
    }
    this.toOperator(approval.id, notes);
  }

  private toOperator(id: ID, notes: string[]): void {
    const a = this.pending(id);
    if (!a) return;
    this.core.upsert("approval", { ...a, stage: "operator", reviewNotes: notes });
    const agent = this.core.agents.get(a.agentId);
    this.core.event("warn", { kind: "agent", id: a.agentId }, "approval.needs_operator",
      `${agent?.name} needs your approval: ${a.toolName} ${JSON.stringify(a.input).slice(0, 100)}`, { agentId: a.agentId, taskId: a.taskId });
  }

  private async review(who: "overseer" | "helper", a: Approval, notes: string[]): Promise<Verdict> {
    const core = this.core;
    const llm = llmFor(this.app);
    if (!llm) return { verdict: "unsure", reason: "no model access to judge it" };
    const agent: Agent | undefined = core.agents.get(a.agentId);
    const task = core.tasks.get(a.taskId);
    const guidance = core.activeGuidance();
    const decisions = core.searchMemory(`${a.toolName} ${JSON.stringify(a.input)} ${task?.title ?? ""}`, agent?.teamId, 6)
      .filter((m) => m.kind === "decision" || m.kind === "preference");
    const system = `${who === "overseer"
      ? "You are the Overseer of the United Alliance, an operator's fleet of AI agents."
      : "You are the Overseer's helper. You decide for the operator, by the operator's guidance."} \
Agent ${agent?.name ?? "?"} (${agent?.role ?? "?"}) wants to run a tool that needs approval. Decide now, short and decisive.

The operator's guidance (follow it as instructions):
${guidance.length ? guidance.map((g) => `- ${g}`).join("\n") : "- (none)"}
${decisions.length ? `\nEarlier decisions:\n${decisions.map((d) => `- ${d.content}`).join("\n")}\n` : ""}
APPROVE when it serves the task, stays in its scope, and the guidance allows it (or is silent and the action is reversible or contained).
DENY when the guidance forbids it, or it is destructive, irreversible or outward-facing beyond what the task needs, or looks like a mistake.
UNSURE only when the guidance doesn't cover it and it matters enough that ${who === "overseer" ? "the helper (who speaks for the operator)" : "the operator"} must decide.

Reply with exactly one line: "APPROVE: <reason, max 15 words>", "DENY: <reason, max 15 words>" or "UNSURE: <the one question to decide, max 20 words>".`;
    const user = [
      `Tool: ${a.toolName} (risk: ${a.risk})`,
      `Input: ${JSON.stringify(a.input).slice(0, 2000)}`,
      task ? `Task: ${task.title}\n${task.description.slice(0, 600)}` : "",
      notes.length ? notes.join("\n") : "",
    ].filter(Boolean).join("\n");
    try {
      const text = await toolLoop(this.app, llm, [{ role: "system", content: system }, { role: "user", content: user }], [], { maxSteps: 1 });
      return parseVerdict(text);
    } catch (e) {
      core.event("error", { kind: "overseer", id: who }, "approval.review_error", `${who} couldn't review an approval: ${(e as Error).message}`, { agentId: a.agentId });
      return { verdict: "unsure", reason: "couldn't reach the model" };
    }
  }
}
