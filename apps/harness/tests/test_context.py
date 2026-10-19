from __future__ import annotations

import asyncio
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from harness import context
from harness.adapters import Completion
from harness.instance import InstanceLock
from harness.runtime import AgentRun

from .fakes import FakeConn, ScriptedAdapter, final_turn, tool_turn
from .test_harness import AGENT, TASK


def run(coro):
    return asyncio.run(coro)


def long_history(turns: int, result_chars: int) -> list[dict]:
    h = [{"role": "system", "content": "rules"}, {"role": "user", "content": "Start the task."}]
    for i in range(turns):
        h.append({"role": "assistant", "content": None, "tool_calls": [
            {"id": f"c{i}", "type": "function", "function": {"name": "read_file", "arguments": f'{{"path": "f{i}.txt"}}'}}]})
        h.append({"role": "tool", "tool_call_id": f"c{i}", "content": "x" * result_chars})
    return h


class CompactionTests(unittest.TestCase):
    def test_compaction_keeps_head_and_recent_turns_and_never_orphans_tool_results(self):
        history = long_history(turns=60, result_chars=6_000)  # ~120k tokens estimated
        self.assertTrue(context.needs_compaction(history, 64_000))
        seen: list[str] = []

        async def summarize(transcript: str) -> str:
            seen.append(transcript)
            return "- read f0..f40"

        out = run(context.compact(history, summarize, 64_000))
        self.assertEqual(out[:2], history[:2])
        self.assertTrue(out[2]["content"].startswith(context.SUMMARY_MARKER))
        self.assertIn("read f0..f40", out[2]["content"])
        self.assertNotEqual(out[3]["role"], "tool")  # the tail starts on its assistant turn
        self.assertEqual(out[-1], history[-1])
        self.assertFalse(context.needs_compaction(out, 64_000))
        # The summariser got a bounded transcript, not the raw 360k characters.
        self.assertLess(len(seen[0]), 64_000 * 0.5 * context.CHARS_PER_TOKEN + 100)

    def test_failed_summary_falls_back_instead_of_raising(self):
        async def broken(_t: str) -> str:
            raise RuntimeError("model down")

        out = run(context.compact(long_history(60, 6_000), broken, 64_000))
        self.assertIn("Automatic summary unavailable", out[2]["content"])

    def test_one_huge_tool_result_is_clipped(self):
        history = long_history(turns=1, result_chars=1_000_000)

        async def summarize(_t: str) -> str:
            return "s"

        out = run(context.compact(history, summarize, 64_000))
        self.assertLess(context.estimate_tokens(out), context.budget(64_000))

    def test_overflow_errors_are_recognised(self):
        self.assertTrue(context.is_context_overflow(Exception(
            "Error code: 400 - This model's maximum context length is 65536 tokens. However, you requested 70000 tokens")))
        self.assertFalse(context.is_context_overflow(Exception("Error code: 401 - invalid api key")))

    def test_window_is_learned_from_the_error(self):
        err = Exception("This model's maximum context length is 65,536 tokens. However, you requested 90000 tokens")
        self.assertEqual(context.window_after_overflow(err, 128_000), 65_536)
        self.assertEqual(context.window_after_overflow(Exception("prompt is too long"), 100_000), 70_000)


class OverflowAdapter(ScriptedAdapter):
    """Rejects the first agent request as too long, then behaves."""

    def __init__(self, completions: list[Completion]) -> None:
        super().__init__(completions)
        self.rejected = False

    async def complete(self, messages, tools, model, run_id, on_text):
        if tools and not self.rejected:
            self.rejected = True
            raise Exception("Error code: 400 - This model's maximum context length is 65536 tokens.")
        return await super().complete(messages, tools, model, run_id, on_text)


class RuntimeCompactionTests(unittest.TestCase):
    def test_run_recovers_from_a_context_overflow_and_checkpoints_the_new_history(self):
        with tempfile.TemporaryDirectory() as d:
            conn = FakeConn()
            # Summary call, then the retried agent call.
            adapter = OverflowAdapter([final_turn("- summary"), final_turn("All done.")])
            r = AgentRun(run_id="run_1", agent=AGENT, task=TASK, briefing={}, model="deepseek-flash", adapter=adapter,
                         conn=conn, workdir=Path(d), resume_messages=long_history(40, 2_000), context_window=64_000)
            run(r.run())
            self.assertEqual(conn.of("run.status")[-1]["status"], "succeeded")
            cp = conn.of("run.checkpoint")[-1]
            self.assertTrue(cp["compacted"])
            self.assertEqual(cp["messages"], r.history)
            self.assertTrue(any(e["event"].get("kind") == "log" and "compacted" in e["event"]["message"] for e in conn.of("run.event")))

    def test_long_run_compacts_before_hitting_the_limit(self):
        with tempfile.TemporaryDirectory() as d:
            workdir = Path(d).resolve()
            (workdir / "big.txt").write_text("y" * 19_000)
            turns = [tool_turn((f"c{i}", "read_file", '{"path": "big.txt"}')) for i in range(12)]
            adapter = ScriptedAdapter(turns + [final_turn("- summary"), final_turn("done")])
            r = AgentRun(run_id="run_2", agent=AGENT, task=TASK, briefing={}, model="m", adapter=adapter,
                         conn=FakeConn(), workdir=workdir, context_window=64_000)
            run(r.run())
            biggest = max(context.estimate_tokens(h) for h in adapter.seen)
            self.assertLess(biggest, context.budget(64_000))


LOCK_SCRIPT = """
import sys, time
from pathlib import Path
from harness.instance import InstanceLock
lock = InstanceLock(Path(sys.argv[1]))
print("acquired" if lock.try_acquire() else "busy", flush=True)
time.sleep(float(sys.argv[2]))
"""


class InstanceLockTests(unittest.TestCase):
    def test_second_instance_waits_until_the_first_exits(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(__file__).resolve().parents[1]
            first = subprocess.Popen([sys.executable, "-c", LOCK_SCRIPT, d, "3"], cwd=root, stdout=subprocess.PIPE, text=True)
            try:
                self.assertEqual(first.stdout.readline().strip(), "acquired")
                lock = InstanceLock(Path(d))
                self.assertFalse(lock.try_acquire())  # standby while the first runs
                first.wait(10)
                run(asyncio.wait_for(lock.wait(poll_s=0.1), 5))  # takes over once it's gone
                self.assertTrue(lock.held)
                lock.release()
            finally:
                first.kill()
                first.stdout.close()


if __name__ == "__main__":
    unittest.main()
