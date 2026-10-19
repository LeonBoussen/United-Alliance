"""DeepSeek adapter: OpenAI-format Chat Completions via the `openai` SDK.

base_url and api key come from the Overseer (ModelAccess): the gateway URL and a
harness token by default, or https://api.deepseek.com and the real key in direct mode.
"""

from __future__ import annotations

from typing import Awaitable, Callable

import openai
from openai import AsyncOpenAI

from . import Completion, ToolCall

_FINISH = {"stop": "done", "tool_calls": "tool_calls", "length": "length", "content_filter": "refused"}


class DeepSeekAdapter:
    def __init__(self, access: dict) -> None:
        self.client = AsyncOpenAI(base_url=access["baseUrl"], api_key=access["token"], max_retries=3)

    async def complete(
        self,
        messages: list[dict],
        tools: list[dict],
        model: str,
        run_id: str,
        on_text: Callable[[str], Awaitable[None]],
    ) -> Completion:
        # Thinking mode is left off for now: replaying reasoning content across tool turns
        # needs care per DeepSeek's docs. Enable via extra_body={"thinking": {...}} when added.
        stream = await self.client.chat.completions.create(
            model=model,
            messages=messages,
            tools=tools or openai.NOT_GIVEN,
            stream=True,
            stream_options={"include_usage": True},
            extra_headers={"x-alliance-run": run_id},
        )
        text: list[str] = []
        calls: dict[int, dict] = {}
        finish = "stop"
        usage: dict = {}
        async for chunk in stream:
            if chunk.usage:
                usage = {
                    "inputTokens": chunk.usage.prompt_tokens,
                    "outputTokens": chunk.usage.completion_tokens,
                    "cacheReadTokens": getattr(chunk.usage, "prompt_cache_hit_tokens", 0) or 0,
                }
            if not chunk.choices:
                continue
            choice = chunk.choices[0]
            delta = choice.delta
            if delta.content:
                text.append(delta.content)
                await on_text(delta.content)
            for tc in delta.tool_calls or []:
                slot = calls.setdefault(tc.index, {"id": "", "name": "", "arguments": ""})
                if tc.id:
                    slot["id"] = tc.id
                if tc.function and tc.function.name:
                    slot["name"] += tc.function.name
                if tc.function and tc.function.arguments:
                    slot["arguments"] += tc.function.arguments
            if choice.finish_reason:
                finish = choice.finish_reason

        tool_calls = [ToolCall(c["id"], c["name"], c["arguments"]) for _, c in sorted(calls.items())]
        content = "".join(text)
        message: dict = {"role": "assistant", "content": content or None}
        if tool_calls:
            message["tool_calls"] = [
                {"id": c.id, "type": "function", "function": {"name": c.name, "arguments": c.arguments}} for c in tool_calls
            ]
        return Completion(content, tool_calls, _FINISH.get(finish, "done"), usage, message)
