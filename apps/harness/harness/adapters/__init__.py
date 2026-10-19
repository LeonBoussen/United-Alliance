"""Provider adapters. Each turns a neutral request into a provider API call (DESIGN §4.2.2)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Awaitable, Callable, Protocol


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: str  # raw JSON string as produced by the model


@dataclass
class Completion:
    text: str
    tool_calls: list[ToolCall]
    #: Neutral finish reason: "done" | "tool_calls" | "length" | "refused"
    finish: str
    usage: dict = field(default_factory=dict)
    #: The assistant message to append to history, in the history's format.
    message: dict = field(default_factory=dict)


class Adapter(Protocol):
    async def complete(
        self,
        messages: list[dict],
        tools: list[dict],
        model: str,
        run_id: str,
        on_text: Callable[[str], Awaitable[None]],
    ) -> Completion: ...


def make_adapter(access: dict) -> Adapter:
    provider = access.get("provider")
    if provider == "deepseek":
        from .deepseek import DeepSeekAdapter  # imported lazily so tests don't need the SDK

        return DeepSeekAdapter(access)
    raise ValueError(f"provider {provider!r} is not supported by this harness yet")
