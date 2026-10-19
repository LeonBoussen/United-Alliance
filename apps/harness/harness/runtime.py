"""The agent loop for one run (DESIGN §4.2.1).

History is append-only between compactions. Overseer messages, operator thoughts and
board mentions are injected at turn boundaries. After every turn a checkpoint (the
messages appended since the last one) is sent to the Overseer, so a run can resume
elsewhere. When the history nears the model's context window it is compacted
(harness/context.py) and the next checkpoint carries the whole new history.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Callable

from . import context
from .adapters import Adapter, Completion
from .tools import Conn, ToolContext, ToolSet

log = logging.getLogger("harness.runtime")

#: Compaction keeps the history bounded, so this only stops runaway loops.
MAX_TURNS = 400
#: Retries of one model call after the provider rejected it as too long.
MAX_OVERFLOW_RETRIES = 3

AGENT_RULES = """You work for the Overseer of the United Alliance. Normally you cannot contact the operator: \
if you are blocked, unsure, or need a decision, use ask_overseer. Messages marked [operator thought] \
come from the operator; treat them as high-priority guidance that overrides your briefing where they \
conflict. After a thought you may answer the operator with reply_to_operator until the time given in \
the message; set question=true only if you truly need the operator's input. If the operator doesn't \
answer in time, the Overseer answers instead; treat that answer as final. Never try to reach the \
operator outside that window. Report progress with report_progress. Other agents work alongside you: \
the board (board_read, board_post) is where everyone coordinates in the open, and the operator reads \
it too. Check it when you start, post plans, hand-offs and useful findings there, and write @Name to \
notify a specific agent; messages marked [board] are posts that mention you. When the task is done, \
reply with a short summary of the result and stop calling tools."""

_INJECT_LABEL = {
    "overseer": "[overseer]",
    "operator_thought": "[operator thought]",
    "operator_answer": "[operator answer]",
    "overseer_answer": "[overseer answer: the operator did not respond in time]",
    "board": "[board]",
}


def system_prompt(agent: dict, task: dict, briefing: dict) -> str:
    parts = [AGENT_RULES, f"\nYou are {agent['name']}, {agent['role']}."]
    if briefing.get("teammates"):
        parts.append("\nOther agents right now: " + "; ".join(briefing["teammates"]))
    if agent.get("instructions"):
        parts.append(f"\nInstructions:\n{agent['instructions']}")
    parts.append(f"\nTask: {task.get('title')}\n{task.get('description') or ''}")
    if briefing.get("acceptance"):
        parts.append(f"\nDone when: {briefing['acceptance']}")
    if briefing.get("dossierSummary"):
        parts.append(f"\nWhat the Overseer knows about you: {briefing['dossierSummary']}")
    if briefing.get("memories"):
        parts.append("\nRelevant memory:\n" + "\n".join(f"- {m['content']}" for m in briefing["memories"]))
    if briefing.get("operatorPreferences"):
        parts.append("\nOperator preferences:\n" + "\n".join(f"- {p}" for p in briefing["operatorPreferences"]))
    if task.get("budget", {}).get("tokens"):
        parts.append(f"\nToken budget for this task: {task['budget']['tokens']:,}. Pace yourself.")
    return "\n".join(parts)


class AgentRun:
    def __init__(
        self,
        *,
        run_id: str,
        agent: dict,
        task: dict,
        briefing: dict,
        model: str,
        adapter: Adapter,
        conn: Conn,
        workdir: Any,
        resume_messages: list[dict] | None = None,
        context_window: int | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.run_id = run_id
        self.agent = agent
        self.model = model
        self.adapter = adapter
        self.conn = conn
        self.workdir = workdir
        self.tools = ToolSet.from_grants(agent.get("tools", []))
        self.history: list[dict] = list(resume_messages or []) or [
            {"role": "system", "content": system_prompt(agent, task, briefing)},
            {"role": "user", "content": "Start the task."},
        ]
        self._checkpointed = len(resume_messages or [])
        self.context_window = context_window
        #: Set after a compaction: the next checkpoint sends the whole history.
        self._compacted = False
        self.inbox: asyncio.Queue[dict] = asyncio.Queue()
        self._resume = asyncio.Event()
        self._resume.set()
        self._seq = 0
        self._turn = 0
        self._clock = clock
        self.usage = {"inputTokens": 0, "outputTokens": 0, "cacheReadTokens": 0, "costUsd": 0.0}

    # -- control from the host --------------------------------------------------

    def inject(self, payload: dict) -> None:
        self.inbox.put_nowait(payload)

    def pause(self) -> None:
        self._resume.clear()

    def resume(self) -> None:
        self._resume.set()

    # -- loop ---------------------------------------------------------------------

    async def emit(self, event: dict) -> None:
        self._seq += 1
        await self.conn.send("run.event", {"runId": self.run_id, "seq": self._seq, "event": event})

    def _drain_inbox(self) -> None:
        while not self.inbox.empty():
            p = self.inbox.get_nowait()
            label = _INJECT_LABEL.get(p.get("from", ""), "[message]")
            text = f"{label} {p.get('content', '')}"
            if p.get("windowOpenUntil"):
                text += f"\n(You may use reply_to_operator until {p['windowOpenUntil']}.)"
            self.history.append({"role": "user", "content": text})

    async def _checkpoint(self, note: str | None = None) -> None:
        delta = self.history if self._compacted else self.history[self._checkpointed:]
        self._checkpointed = len(self.history)
        payload = {
            "runId": self.run_id, "seq": self._seq, "turn": self._turn, "messageCount": len(self.history),
            "messages": delta, "usage": self.usage,
        }
        if self._compacted:
            payload["compacted"] = True
            self._compacted = False
        if note:
            payload["note"] = note
        await self.conn.send("run.checkpoint", payload)

    def _add_usage(self, usage: dict) -> None:
        for k in ("inputTokens", "outputTokens", "cacheReadTokens"):
            self.usage[k] += int(usage.get(k, 0) or 0)

    async def _summarize(self, transcript: str) -> str:
        async def ignore(_t: str) -> None:
            pass

        c = await self.adapter.complete(
            [{"role": "system", "content": context.SUMMARY_PROMPT}, {"role": "user", "content": transcript}],
            [], self.model, self.run_id, ignore,
        )
        self._add_usage(c.usage)
        return c.text

    async def _compact(self, aggressive: bool = False) -> None:
        before = context.estimate_tokens(self.history)
        self.history = await context.compact(self.history, self._summarize, self.context_window, aggressive=aggressive)
        self._compacted = True
        after = context.estimate_tokens(self.history)
        await self.emit({
            "kind": "log", "level": "info",
            "message": f"compacted its history to stay within the context window (~{before:,} → ~{after:,} tokens)",
        })

    async def _complete(self, on_text: Callable[[str], Any]) -> Completion:
        """One model call. Compacts first when the history is near the limit, and again
        (harder) if the provider still rejects the request as too long."""
        if context.needs_compaction(self.history, self.context_window):
            await self._compact()
        for attempt in range(MAX_OVERFLOW_RETRIES + 1):
            try:
                return await self.adapter.complete(self.history, self.tools.schemas(), self.model, self.run_id, on_text)
            except Exception as e:
                if attempt == MAX_OVERFLOW_RETRIES or not context.is_context_overflow(e):
                    raise
                # The window may be smaller than we were told: learn it from the error.
                self.context_window = context.window_after_overflow(e, self.context_window)
                log.warning("run %s: request exceeded the context window (%s); compacting to ~%d tokens and retrying",
                            self.run_id, e, self.context_window)
                await self._compact(aggressive=True)
        raise AssertionError("unreachable")

    async def run(self) -> None:
        try:
            result = await self._loop()
            await self.conn.send("run.status", {"runId": self.run_id, "status": "succeeded", "result": result})
        except asyncio.CancelledError:
            await self.conn.send("run.status", {"runId": self.run_id, "status": "cancelled"})
            raise
        except Exception as e:
            log.exception("run %s failed", self.run_id)
            await self.conn.send(
                "run.status", {"runId": self.run_id, "status": "failed", "error": {"code": type(e).__name__, "message": str(e)}}
            )

    async def _loop(self) -> str:
        while self._turn < MAX_TURNS:
            await self._resume.wait()  # pause takes effect at turn boundaries
            self._drain_inbox()
            self._turn += 1
            await self.emit({"kind": "turn.start", "turn": self._turn})

            async def on_text(t: str) -> None:
                await self.emit({"kind": "text.delta", "text": t})

            c = await self._complete(on_text)
            self.history.append(c.message)
            self._add_usage(c.usage)
            await self.emit({"kind": "turn.end", "turn": self._turn, "stopReason": c.finish, "usage": dict(self.usage)})

            if c.tool_calls:
                results = await asyncio.gather(*(self._call_tool(tc) for tc in c.tool_calls))
                self.history.extend(results)  # one tool message per call id, all before the next request
            elif c.finish == "done":
                await self._checkpoint("done")
                return c.text
            elif c.finish == "refused":
                raise RuntimeError("the model declined the request")
            # "length" (or tool calls): continue with the next turn
            await self._checkpoint()
        raise RuntimeError(f"stopped after {MAX_TURNS} turns without finishing")

    async def _call_tool(self, tc: Any) -> dict:
        await self.emit({"kind": "tool.call", "toolUseId": tc.id, "name": tc.name, "input": tc.arguments})
        started = self._clock()
        ctx = ToolContext(run_id=self.run_id, tool_call_id=tc.id, conn=self.conn, workdir=self.workdir, emit=self.emit)
        ok, output = await self.tools.call(tc.name, tc.arguments, ctx)
        await self.emit({
            "kind": "tool.result", "toolUseId": tc.id, "ok": ok, "output": output[:2000],
            "durationMs": int((self._clock() - started) * 1000),
        })
        return {"role": "tool", "tool_call_id": tc.id, "content": output if ok else f"ERROR: {output}"}
