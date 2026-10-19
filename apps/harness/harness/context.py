"""Keeps a run's history inside the model's context window (DESIGN §4.2.1).

DeepSeek has no server-side compaction, so a long run would eventually send more
tokens than the model accepts and fail. Before every model call the runtime checks
the estimated size; past a threshold the older middle of the history is summarised
(by the model itself, or mechanically if that fails) and replaced with one
"[context summary]" message. The system prompt, the opening message and the most
recent turns are kept verbatim. Tool results are never separated from the assistant
turn that called them.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Awaitable, Callable

log = logging.getLogger("harness.context")

#: Used when the Overseer doesn't say how big the model's window is.
DEFAULT_CONTEXT_WINDOW = 128_000
#: Compact once the history is estimated above this share of the window.
COMPACT_AT = 0.70
#: After compacting, keep roughly this share of the window as verbatim recent turns.
KEEP_RECENT = 0.30
#: Room reserved for the model's answer.
OUTPUT_RESERVE = 8_000
#: Code and JSON tokenize densely; 3 chars per token errs on the safe side.
CHARS_PER_TOKEN = 3.0
SUMMARY_MARKER = "[context summary]"

Summarize = Callable[[str], Awaitable[str]]

SUMMARY_PROMPT = """You compress the working memory of an AI agent that is in the middle of a task. \
Below is a transcript of its earlier turns (tool calls and results are abbreviated). Write a summary \
the agent can continue from without the transcript. Keep: the goal and constraints, decisions made and \
why, what was done (files written, commands run, their outcomes), facts discovered (paths, names, \
numbers, errors), what remains to do, and open questions. Drop chit-chat and anything superseded. \
Use terse bullet points. At most 900 words."""


def _message_chars(m: dict) -> int:
    n = len(m.get("content") or "")
    for tc in m.get("tool_calls") or []:
        fn = tc.get("function") or {}
        n += len(fn.get("name") or "") + len(fn.get("arguments") or "")
    return n + 16  # role, ids and formatting overhead


def estimate_tokens(messages: list[dict]) -> int:
    return int(sum(_message_chars(m) for m in messages) / CHARS_PER_TOKEN)


def budget(context_window: int | None) -> int:
    """Tokens the history may use before the model call has no room left."""
    window = context_window or DEFAULT_CONTEXT_WINDOW
    return max(4_000, window - min(OUTPUT_RESERVE, window // 4))


def needs_compaction(messages: list[dict], context_window: int | None) -> bool:
    return estimate_tokens(messages) > budget(context_window) * COMPACT_AT


def _clip(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    half = limit // 2
    return f"{text[:half]}\n… [{len(text) - limit} chars omitted] …\n{text[-half:]}"


def render_transcript(messages: list[dict], max_chars: int) -> str:
    """Readable, size-bounded transcript of `messages` for the summariser."""
    lines: list[str] = []
    for m in messages:
        role = m.get("role")
        content = m.get("content") or ""
        if role == "assistant":
            if content:
                lines.append(f"ASSISTANT: {_clip(content, 2_000)}")
            for tc in m.get("tool_calls") or []:
                fn = tc.get("function") or {}
                lines.append(f"TOOL CALL {fn.get('name')}: {_clip(fn.get('arguments') or '', 600)}")
        elif role == "tool":
            lines.append(f"TOOL RESULT: {_clip(content, 1_200)}")
        else:
            lines.append(f"{str(role).upper()}: {_clip(content, 3_000)}")
    text = "\n".join(lines)
    # Too long even abbreviated: the most recent part matters most.
    return text if len(text) <= max_chars else "… [earliest turns omitted]\n" + text[-max_chars:]


def _split_point(messages: list[dict], start: int, keep_tokens: int) -> int:
    """Index where the verbatim tail begins: as many recent messages as fit in
    `keep_tokens`, never starting on a tool result (it must follow its assistant turn)."""
    used = 0
    split = len(messages)
    for i in range(len(messages) - 1, start - 1, -1):
        used += int(_message_chars(messages[i]) / CHARS_PER_TOKEN)
        if used > keep_tokens:
            break
        split = i
    while split < len(messages) and messages[split].get("role") == "tool":
        split += 1
    return split


def _shrink_tool_results(messages: list[dict], limit: int) -> list[dict]:
    return [
        {**m, "content": _clip(m.get("content") or "", limit)} if m.get("role") == "tool" else m
        for m in messages
    ]


def _fallback_summary(transcript: str) -> str:
    return "Automatic summary unavailable; the latest part of the earlier transcript follows.\n" + transcript[-6_000:]


async def compact(
    messages: list[dict],
    summarize: Summarize,
    context_window: int | None,
    *,
    aggressive: bool = False,
) -> list[dict]:
    """Return a shorter history that keeps the run going.

    `aggressive` is used after the provider rejected a request as too long: keep less
    verbatim and clip tool results harder.
    """
    limit = budget(context_window)
    head = messages[:2]  # system prompt + the opening user message
    keep = int(limit * (KEEP_RECENT / 2 if aggressive else KEEP_RECENT))
    split = _split_point(messages, len(head), keep)
    middle, tail = messages[len(head):split], messages[split:]

    if middle:
        transcript = render_transcript(middle, max_chars=int(limit * 0.5 * CHARS_PER_TOKEN))
        try:
            summary = (await summarize(transcript)).strip() or _fallback_summary(transcript)
        except Exception as e:  # the run must not die because the summary failed
            log.warning("summarising history failed (%s); using a mechanical summary", e)
            summary = _fallback_summary(transcript)
        note = {
            "role": "user",
            "content": f"{SUMMARY_MARKER} Earlier turns of this run were compacted to stay within the "
            f"context window. Summary of what happened so far:\n{summary}\n\nContinue the task from here.",
        }
        compacted = head + [note] + tail
    else:
        compacted = list(messages)

    # One huge tool result (or a very long tail) can still overflow: clip until it fits.
    for clip in ((4_000, 1_500, 500) if aggressive else (12_000, 4_000, 1_500, 500)):
        if estimate_tokens(compacted) <= limit * COMPACT_AT:
            break
        compacted = compacted[:2] + _shrink_tool_results(compacted[2:], clip)
    log.info("compacted history: %d → %d messages, ~%d → ~%d tokens",
             len(messages), len(compacted), estimate_tokens(messages), estimate_tokens(compacted))
    return compacted


def _error_text(err: BaseException) -> str:
    text = f"{getattr(err, 'code', '') or ''} {err}".lower()
    try:
        body = getattr(err, "body", None)
        if body:
            text += " " + json.dumps(body).lower()
    except (TypeError, ValueError):
        pass
    return text


def window_after_overflow(err: BaseException, current: int | None) -> int:
    """The context window to assume after `err`: the limit the provider states
    ("maximum context length is 65536 tokens"), or a smaller guess."""
    m = re.search(r"(?:maximum context length|context window|context length)[^0-9]{0,40}([0-9][0-9,]{3,})", _error_text(err))
    if m:
        stated = int(m.group(1).replace(",", ""))
        if stated > 1_000:
            return min(stated, current or stated)
    return max(8_000, int((current or DEFAULT_CONTEXT_WINDOW) * 0.7))


def is_context_overflow(err: BaseException) -> bool:
    """Whether a provider error means "the request is longer than the context window"."""
    text = _error_text(err)
    return any(s in text for s in (
        "context_length", "context length", "maximum context", "context window", "too many tokens",
        "prompt is too long", "reduce the length", "input is too long",
    ))
