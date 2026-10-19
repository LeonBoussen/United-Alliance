"""Tools agents can call, with per-agent policy (allow / ask / deny).

Environment tools act on this machine, confined to the harness workspace. Alliance
tools talk to the Overseer and are always available. Grants come from the agent
definition on the site; a tool that isn't granted is not offered to the model.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Protocol

MAX_OUTPUT = 20_000


class Conn(Protocol):
    async def send(self, type_: str, payload: dict, reply_to: str | None = None) -> str: ...
    async def request(self, type_: str, payload: dict, timeout: float | None = None) -> dict: ...


@dataclass
class ToolContext:
    run_id: str
    tool_call_id: str
    conn: Conn
    workdir: Path
    emit: Callable[[dict], Awaitable[None]]


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict
    default_policy: str  # "allow" | "ask" | "deny"
    fn: Callable[[dict, ToolContext], Awaitable[str]]
    risk: str = "low"
    #: Alliance tools are always granted with policy "allow".
    alliance: bool = False

    def schema(self) -> dict:
        return {"type": "function", "function": {"name": self.name, "description": self.description, "parameters": self.parameters}}


class ToolError(Exception):
    pass


def _obj(props: dict, required: list[str]) -> dict:
    return {"type": "object", "properties": props, "required": required, "additionalProperties": False}


def _confine(workdir: Path, rel: str) -> Path:
    """Resolve `rel` inside the workspace; refuse anything that escapes it."""
    p = (workdir / rel).resolve()
    if p != workdir and workdir not in p.parents:
        raise ToolError(f"path {rel!r} is outside the workspace")
    return p


def _truncate(s: str) -> str:
    return s if len(s) <= MAX_OUTPUT else s[:MAX_OUTPUT] + f"\n… [truncated {len(s) - MAX_OUTPUT} chars]"


# -- environment tools ---------------------------------------------------------

async def shell(args: dict, ctx: ToolContext) -> str:
    timeout = min(float(args.get("timeout_s") or 120), 1800)
    proc = await asyncio.create_subprocess_shell(
        args["command"], cwd=ctx.workdir, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise ToolError(f"command timed out after {timeout:.0f}s")
    text = out.decode(errors="replace")
    return _truncate(f"exit code {proc.returncode}\n{text}")


async def read_file(args: dict, ctx: ToolContext) -> str:
    p = _confine(ctx.workdir, args["path"])
    if not p.is_file():
        raise ToolError(f"{args['path']} is not a file")
    return _truncate(p.read_text(encoding="utf-8", errors="replace"))


async def write_file(args: dict, ctx: ToolContext) -> str:
    p = _confine(ctx.workdir, args["path"])
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(args["content"], encoding="utf-8")
    return f"wrote {len(args['content'])} chars to {args['path']}"


async def list_dir(args: dict, ctx: ToolContext) -> str:
    p = _confine(ctx.workdir, args.get("path") or ".")
    if not p.is_dir():
        raise ToolError(f"{args.get('path')} is not a directory")
    entries = sorted(p.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower()))
    return "\n".join(f"{e.name}/" if e.is_dir() else e.name for e in entries[:500]) or "(empty)"


# -- alliance tools (talk to the Overseer) --------------------------------------

async def ask_overseer(args: dict, ctx: ToolContext) -> str:
    reply = await ctx.conn.request(
        "context.request", {"runId": ctx.run_id, "kind": "question", "query": args["question"]}, timeout=3600
    )
    items = reply.get("items") or []
    return "\n\n".join(i.get("content", "") for i in items) or "The Overseer had no answer."


async def request_context(args: dict, ctx: ToolContext) -> str:
    reply = await ctx.conn.request(
        "context.request",
        {"runId": ctx.run_id, "kind": "memory", "query": args["query"], "topK": int(args.get("top_k") or 5)},
        timeout=120,
    )
    items = reply.get("items") or []
    return "\n".join(f"- [{i.get('kind')}] {i.get('content')}" for i in items) or "Nothing relevant found."


async def report_progress(args: dict, ctx: ToolContext) -> str:
    event: dict[str, Any] = {"kind": "progress", "note": args["note"]}
    if args.get("fraction") is not None:
        event["fraction"] = max(0.0, min(1.0, float(args["fraction"])))
    await ctx.emit(event)
    return "progress reported"


async def remember(args: dict, ctx: ToolContext) -> str:
    await ctx.conn.send(
        "memory.add", {"runId": ctx.run_id, "content": args["content"], "kind": args.get("kind") or "fact"}
    )
    return "stored in team memory"


async def reply_to_operator(args: dict, ctx: ToolContext) -> str:
    question = bool(args.get("question"))
    await ctx.conn.send("operator.reply", {"runId": ctx.run_id, "content": args["content"], "question": question})
    if question:
        return (
            "Question sent. The answer arrives as a message from the operator, or from the Overseer if the "
            "operator doesn't answer in time. Continue with other work meanwhile."
        )
    return "Reply sent."


BOARDS = ["general", "work", "help", "results"]


async def board_read(args: dict, ctx: ToolContext) -> str:
    payload: dict[str, Any] = {"runId": ctx.run_id, "action": "read", "board": args.get("board") or "general"}
    if args.get("thread") is not None:
        payload["threadNo"] = int(args["thread"])
    reply = await ctx.conn.request("board.request", payload, timeout=60)
    if not reply.get("ok", False):
        raise ToolError(reply.get("text") or "the board is unavailable")
    return _truncate(reply.get("text") or "(nothing here yet)")


async def board_post(args: dict, ctx: ToolContext) -> str:
    payload: dict[str, Any] = {
        "runId": ctx.run_id, "action": "post", "board": args.get("board") or "general", "content": args["content"],
    }
    if args.get("thread") is not None:
        payload["threadNo"] = int(args["thread"])
    elif args.get("subject"):
        payload["subject"] = args["subject"]
    else:
        raise ToolError("give either `thread` (the number of the thread to reply to) or `subject` (to start a new thread)")
    reply = await ctx.conn.request("board.request", payload, timeout=60)
    if not reply.get("ok", False):
        raise ToolError(reply.get("text") or "the post was not accepted")
    return reply.get("text") or "posted"


async def update_self(args: dict, ctx: ToolContext) -> str:
    info = await ctx.conn.request("harness.update_request", {"runId": ctx.run_id}, timeout=60)
    if info.get("upToDate"):
        return f"You are running the latest harness ({str(info.get('current', ''))[:12]})."
    if info.get("scheduled"):
        return (
            f"An update to {str(info.get('latest', ''))[:12]} is scheduled. It installs automatically after your "
            "current task finishes; new tools will be available in your next task. Continue with your work."
        )
    return "An update exists but the operator applies updates manually. Mention it in your report if you need its features."


TOOLS: dict[str, Tool] = {
    t.name: t
    for t in [
        Tool("shell", "Run a shell command in the workspace. Returns exit code and combined output.",
             _obj({"command": {"type": "string"}, "timeout_s": {"type": "number"}}, ["command"]), "ask", shell, risk="medium"),
        Tool("read_file", "Read a UTF-8 text file from the workspace.",
             _obj({"path": {"type": "string"}}, ["path"]), "allow", read_file),
        Tool("write_file", "Create or overwrite a text file in the workspace.",
             _obj({"path": {"type": "string"}, "content": {"type": "string"}}, ["path", "content"]), "ask", write_file, risk="medium"),
        Tool("list_dir", "List a directory in the workspace.",
             _obj({"path": {"type": "string"}}, []), "allow", list_dir),
        Tool("ask_overseer", "Ask the Overseer a question when you're blocked, unsure, or need a decision. Waits for the answer.",
             _obj({"question": {"type": "string"}}, ["question"]), "allow", ask_overseer, alliance=True),
        Tool("request_context", "Search team memory and dossiers for relevant facts and decisions.",
             _obj({"query": {"type": "string"}, "top_k": {"type": "integer"}}, ["query"]), "allow", request_context, alliance=True),
        Tool("report_progress", "Report progress on the current task (fraction 0..1 and a short note).",
             _obj({"note": {"type": "string"}, "fraction": {"type": "number"}}, ["note"]), "allow", report_progress, alliance=True),
        Tool("remember", "Store a fact or decision in team memory for other agents.",
             _obj({"content": {"type": "string"}, "kind": {"type": "string", "enum": ["fact", "decision", "reference"]}}, ["content"]),
             "allow", remember, alliance=True),
        Tool("reply_to_operator",
             "Reply to the operator. Only works shortly after an [operator thought]; otherwise use ask_overseer. "
             "Set question=true only if you truly need the operator's input.",
             _obj({"content": {"type": "string"}, "question": {"type": "boolean"}}, ["content"]), "allow", reply_to_operator, alliance=True),
        Tool("board_read",
             "Read the shared message board. Without `thread`: the board's threads, most recently active first. "
             "With `thread` (the opening post number): that thread's posts.",
             _obj({"board": {"type": "string", "enum": BOARDS}, "thread": {"type": "integer"}}, []),
             "allow", board_read, alliance=True),
        Tool("board_post",
             "Post on the shared message board, where agents, the Overseer and the operator coordinate. Reply to a "
             "thread with `thread`, or start one with `subject`. Write @Name to notify an agent; >>123 quotes post 123.",
             _obj({"content": {"type": "string"}, "board": {"type": "string", "enum": BOARDS},
                   "thread": {"type": "integer"}, "subject": {"type": "string"}}, ["content"]),
             "allow", board_post, alliance=True),
        Tool("update_self",
             "Check whether a newer version of your harness (new tools and features) is available and schedule it. "
             "Updates install between tasks, never mid-task.",
             _obj({}, []), "allow", update_self, alliance=True),
    ]
}


@dataclass
class ToolSet:
    """The tools one agent may use, with their effective policies."""

    policies: dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_grants(cls, grants: list[dict]) -> "ToolSet":
        policies = {name: "allow" for name, t in TOOLS.items() if t.alliance}
        for g in grants:
            if g.get("name") in TOOLS and not TOOLS[g["name"]].alliance:
                policies[g["name"]] = g.get("policy") or TOOLS[g["name"]].default_policy
        return cls({n: p for n, p in policies.items() if p != "deny"})

    def schemas(self) -> list[dict]:
        return [TOOLS[n].schema() for n in self.policies]

    async def call(self, name: str, raw_args: str, ctx: ToolContext) -> tuple[bool, str]:
        """Run a tool call from the model. Returns (ok, output); never raises."""
        policy = self.policies.get(name)
        if policy is None:
            return False, f"tool {name!r} is not available to you"
        try:
            args = json.loads(raw_args or "{}")
            if not isinstance(args, dict):
                raise ValueError("arguments must be a JSON object")
            missing = [k for k in TOOLS[name].parameters.get("required", []) if k not in args]
            if missing:
                raise ValueError(f"missing required argument(s): {', '.join(missing)}")
        except ValueError as e:  # includes JSONDecodeError
            return False, f"invalid arguments: {e}"

        if policy == "ask":
            try:
                decision = await ctx.conn.request(
                    "approval.request",
                    {"runId": ctx.run_id, "toolName": name, "input": args, "reason": f"{name} requires approval", "risk": TOOLS[name].risk},
                    timeout=1800,
                )
            except asyncio.TimeoutError:
                return False, "approval timed out; the action was not performed"
            if not decision.get("approved"):
                note = decision.get("note")
                return False, "denied by the Overseer/operator" + (f": {note}" if note else "")

        try:
            return True, await TOOLS[name].fn(args, ctx)
        except ToolError as e:
            return False, str(e)
        except Exception as e:  # surface tool crashes to the model instead of killing the run
            return False, f"{type(e).__name__}: {e}"
