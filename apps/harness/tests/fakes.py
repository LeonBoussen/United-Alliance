from __future__ import annotations

from harness.adapters import Completion, ToolCall


class FakeConn:
    """Records sent messages; answers requests from a scripted dict keyed by type."""

    def __init__(self, replies: dict[str, dict] | None = None) -> None:
        self.sent: list[tuple[str, dict]] = []
        self.requests: list[tuple[str, dict]] = []
        self.replies = replies or {}

    async def send(self, type_: str, payload: dict, reply_to: str | None = None) -> str:
        self.sent.append((type_, payload))
        return "id"

    async def request(self, type_: str, payload: dict, timeout: float | None = None) -> dict:
        self.requests.append((type_, payload))
        return self.replies.get(type_, {})

    def of(self, type_: str) -> list[dict]:
        return [p for t, p in self.sent if t == type_]


class ScriptedAdapter:
    """Returns pre-baked completions in order and records the history it was given."""

    def __init__(self, completions: list[Completion]) -> None:
        self.completions = list(completions)
        self.seen: list[list[dict]] = []

    async def complete(self, messages, tools, model, run_id, on_text):
        self.seen.append([dict(m) for m in messages])
        c = self.completions.pop(0)
        if c.text:
            await on_text(c.text)
        return c


def tool_turn(*calls: tuple[str, str, str]) -> Completion:
    tcs = [ToolCall(i, n, a) for i, n, a in calls]
    msg = {"role": "assistant", "content": None, "tool_calls": [
        {"id": c.id, "type": "function", "function": {"name": c.name, "arguments": c.arguments}} for c in tcs
    ]}
    return Completion("", tcs, "tool_calls", {"inputTokens": 10, "outputTokens": 5}, msg)


def final_turn(text: str) -> Completion:
    return Completion(text, [], "done", {"inputTokens": 12, "outputTokens": 7}, {"role": "assistant", "content": text})
