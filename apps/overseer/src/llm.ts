// The tool loop shared by the Overseer and its helper: an OpenAI-format chat with
// function tools, kept inside the model's context window.
import OpenAI from "openai";
import type { App } from "./app.js";

export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatTool = OpenAI.Chat.Completions.ChatCompletionFunctionTool;

export interface ToolSpec {
  def: ChatTool;
  run: (args: Record<string, unknown>) => Promise<string> | string;
}

export interface Llm {
  client: OpenAI;
  model: string;
  provider: string;
  /** Context window in tokens (provider registry). */
  contextWindow: number;
}

/** Tool output kept in the conversation; the rest is cut so one big result can't fill the window. */
const MAX_TOOL_OUTPUT = 12_000;
/** Conservative: code and JSON tokenize densely. */
const CHARS_PER_TOKEN = 3;

export function tool(name: string, description: string, properties: Record<string, unknown>, required: string[], run: ToolSpec["run"]): ToolSpec {
  return { def: { type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } }, run };
}

export const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));

export function llmFor(app: App): Llm | undefined {
  const core = app.core;
  const id = core.settings.defaultProvider;
  const p = core.providerSettings(id);
  const key = core.providerKey(id);
  if (!p || !p.available || !p.enabled || !key) return undefined;
  return {
    client: new OpenAI({ baseURL: p.baseUrl, apiKey: key, maxRetries: 2, timeout: 120_000 }),
    model: p.defaultModel,
    provider: id,
    contextWindow: core.providerDefinition(id).contextWindow,
  };
}

function chars(m: ChatMessage): number {
  const content = typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length;
  const calls = "tool_calls" in m && m.tool_calls ? JSON.stringify(m.tool_calls).length : 0;
  return content + calls + 16;
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit / 2)}\n… [${text.length - limit} chars omitted] …\n${text.slice(-limit / 2)}`;
}

/**
 * Fit a conversation into `maxChars`: keep the system prompt(s) and the newest messages,
 * drop the oldest in between, and never start the kept part on a tool result whose
 * assistant turn was dropped. Long single messages are clipped.
 */
export function fitHistory(messages: ChatMessage[], maxChars: number): ChatMessage[] {
  const system = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system").map((m) =>
    typeof m.content === "string" && m.content.length > maxChars / 4 ? ({ ...m, content: clip(m.content, Math.floor(maxChars / 4)) } as ChatMessage) : m,
  );
  let used = system.reduce((n, m) => n + chars(m), 0);
  let start = rest.length;
  for (let i = rest.length - 1; i >= 0; i--) {
    used += chars(rest[i]!);
    if (used > maxChars && start < rest.length) break;
    start = i;
  }
  while (start < rest.length && rest[start]!.role === "tool") start++;
  const kept = rest.slice(start);
  return start > 0 ? [...system, { role: "user", content: "[earlier messages omitted to fit the context window]" }, ...kept] : [...system, ...kept];
}

function isOverflow(e: unknown): boolean {
  const text = `${(e as { code?: string }).code ?? ""} ${(e as Error).message ?? ""}`.toLowerCase();
  return ["context_length", "context length", "maximum context", "context window", "too many tokens", "prompt is too long", "reduce the length"].some((s) => text.includes(s));
}

/**
 * Run the model with tools until it answers without calling one (or `maxSteps`).
 * Returns the final text. A "too long" error shrinks the conversation and retries.
 */
export async function toolLoop(
  app: App,
  llm: Llm,
  messages: ChatMessage[],
  tools: ToolSpec[],
  opts: { maxSteps: number },
): Promise<string> {
  const byName = new Map(tools.map((t) => [t.def.function.name, t]));
  let budget = Math.floor(llm.contextWindow * 0.7 * CHARS_PER_TOKEN);
  let convo = fitHistory(messages, budget);
  for (let step = 0; step < opts.maxSteps; step++) {
    const started = Date.now();
    let res: OpenAI.Chat.Completions.ChatCompletion;
    try {
      res = await llm.client.chat.completions.create({
        model: llm.model,
        messages: convo,
        ...(tools.length ? { tools: tools.map((t) => t.def), tool_choice: "auto" as const } : {}),
      });
    } catch (e) {
      if (!isOverflow(e) || budget < 20_000) throw e;
      budget = Math.floor(budget * 0.6);
      convo = fitHistory(convo, budget);
      continue;
    }
    app.core.recordUsage({
      ts: Date.now(), provider: llm.provider, model: llm.model, source: "overseer", durationMs: Date.now() - started,
      inputTokens: res.usage?.prompt_tokens ?? 0, outputTokens: res.usage?.completion_tokens ?? 0, cacheReadTokens: 0,
    });
    const choice = res.choices[0];
    if (!choice) return "";
    const msg = choice.message;
    const calls = (msg.tool_calls ?? []).filter((c) => c.type === "function");
    if (!calls.length) return msg.content ?? "";
    convo.push({ role: "assistant", content: msg.content ?? null, tool_calls: calls });
    for (const call of calls) {
      let output: string;
      try {
        const args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
        const t = byName.get(call.function.name);
        output = t ? await t.run(args) : `Unknown tool ${call.function.name}`;
      } catch (e) {
        output = `Error: ${(e as Error).message}`;
      }
      convo.push({ role: "tool", tool_call_id: call.id, content: clip(output, MAX_TOOL_OUTPUT) });
    }
    if (convo.reduce((n, m) => n + chars(m), 0) > budget) convo = fitHistory(convo, budget);
  }
  return `I stopped after ${opts.maxSteps} steps without finishing. Ask me again or narrow the request.`;
}
