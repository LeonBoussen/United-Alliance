from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from harness.config import ConfigError, load, save_enrollment
from harness.host import Host
from harness.runtime import AgentRun
from harness.tools import ToolContext, ToolSet

from .fakes import FakeConn, ScriptedAdapter, final_turn, tool_turn

AGENT = {
    "id": "agt_1", "teamId": "team_1", "name": "Forge", "role": "builder", "effort": "high", "maxConcurrentRuns": 1,
    "tools": [{"name": "read_file", "policy": "allow"}, {"name": "write_file", "policy": "ask"}, {"name": "shell", "policy": "deny"}],
}
TASK = {"id": "tsk_1", "title": "Write hello", "description": "Create hello.txt"}


def run(coro):
    return asyncio.run(coro)


class ConfigTests(unittest.TestCase):
    def test_enrollment_token_is_replaced_by_permanent_token(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            (base / "alliance.json").write_text(json.dumps({
                "overseer_url": "http://192.168.1.20:8080", "harness_name": "atlas", "enrollment_token": "enr_x",
            }))
            cfg = load(base)
            self.assertEqual(cfg.ws_url, "ws://192.168.1.20:8080/ws/harness")
            self.assertEqual(cfg.enrollment_token, "enr_x")

            save_enrollment(cfg, "hrn_1", "tok_permanent")
            self.assertNotIn("enrollment_token", json.loads((base / "alliance.json").read_text()))
            again = load(base)
            self.assertEqual((again.token, again.harness_id, again.enrollment_token), ("tok_permanent", "hrn_1", None))

    def test_https_uses_wss_and_missing_tokens_fail(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            (base / "alliance.json").write_text(json.dumps({"overseer_url": "https://ua.example.com/"}))
            with self.assertRaises(ConfigError):
                load(base)  # no token of any kind
            (base / "alliance.json").write_text(json.dumps({"overseer_url": "https://ua.example.com/", "enrollment_token": "e"}))
            self.assertEqual(load(base).ws_url, "wss://ua.example.com/ws/harness")


class ToolTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.workdir = Path(self.tmp.name).resolve()

    def tearDown(self):
        self.tmp.cleanup()

    def ctx(self, conn):
        async def emit(_e):
            pass
        return ToolContext(run_id="run_1", tool_call_id="c1", conn=conn, workdir=self.workdir, emit=emit)

    def test_grants_filter_tools_and_alliance_tools_are_always_on(self):
        ts = ToolSet.from_grants(AGENT["tools"])
        self.assertIn("read_file", ts.policies)
        self.assertEqual(ts.policies["write_file"], "ask")
        self.assertNotIn("shell", ts.policies)  # denied → not offered
        self.assertIn("ask_overseer", ts.policies)
        self.assertIn("reply_to_operator", ts.policies)

    def test_paths_cannot_escape_the_workspace(self):
        ts = ToolSet({"read_file": "allow"})
        ok, out = run(ts.call("read_file", json.dumps({"path": "../../etc/passwd"}), self.ctx(FakeConn())))
        self.assertFalse(ok)
        self.assertIn("outside the workspace", out)

    def test_ask_policy_requests_approval(self):
        ts = ToolSet({"write_file": "ask"})
        denied = FakeConn({"approval.request": {"approved": False, "note": "not now"}})
        ok, out = run(ts.call("write_file", json.dumps({"path": "a.txt", "content": "x"}), self.ctx(denied)))
        self.assertFalse(ok)
        self.assertIn("not now", out)
        self.assertFalse((self.workdir / "a.txt").exists())

        approved = FakeConn({"approval.request": {"approved": True}})
        ok, _ = run(ts.call("write_file", json.dumps({"path": "a.txt", "content": "x"}), self.ctx(approved)))
        self.assertTrue(ok)
        self.assertEqual((self.workdir / "a.txt").read_text(), "x")

    def test_bad_arguments_are_reported_not_raised(self):
        ts = ToolSet({"read_file": "allow"})
        ok, out = run(ts.call("read_file", "{not json", self.ctx(FakeConn())))
        self.assertFalse(ok)
        self.assertIn("invalid arguments", out)
        ok, out = run(ts.call("read_file", "{}", self.ctx(FakeConn())))
        self.assertIn("missing required", out)
        ok, out = run(ts.call("shell", "{}", self.ctx(FakeConn())))
        self.assertIn("not available", out)


class RuntimeTests(unittest.TestCase):
    def test_tool_loop_injection_and_checkpoints(self):
        with tempfile.TemporaryDirectory() as d:
            workdir = Path(d).resolve()
            (workdir / "notes.txt").write_text("hi")
            conn = FakeConn()
            adapter = ScriptedAdapter([
                tool_turn(("c1", "read_file", '{"path": "notes.txt"}'), ("c2", "read_file", '{"path": "missing.txt"}')),
                final_turn("Done: notes say hi."),
            ])
            r = AgentRun(run_id="run_1", agent=AGENT, task=TASK, briefing={}, model="deepseek-flash",
                         adapter=adapter, conn=conn, workdir=workdir)
            r.inject({"from": "operator_thought", "content": "keep it short", "windowOpenUntil": "2026-10-19T12:00:00Z"})
            run(r.run())

            # Thought injected as a labelled message before the first model call.
            first = adapter.seen[0]
            self.assertTrue(first[-1]["content"].startswith("[operator thought] keep it short"))
            self.assertIn("reply_to_operator until", first[-1]["content"])

            # Both tool results returned (one per call id), the failed one marked as an error.
            tool_msgs = [m for m in adapter.seen[1] if m["role"] == "tool"]
            self.assertEqual([m["tool_call_id"] for m in tool_msgs], ["c1", "c2"])
            self.assertEqual(tool_msgs[0]["content"], "hi")
            self.assertTrue(tool_msgs[1]["content"].startswith("ERROR:"))

            # History is append-only: the second call's history starts with the first call's.
            self.assertEqual(adapter.seen[1][: len(adapter.seen[0])], adapter.seen[0])

            # Checkpoint deltas add up to the full history; run succeeded with the final text.
            deltas = [m for cp in conn.of("run.checkpoint") for m in cp["messages"]]
            self.assertEqual(deltas, r.history)
            self.assertEqual(conn.of("run.status")[-1], {"runId": "run_1", "status": "succeeded", "result": "Done: notes say hi."})
            self.assertEqual(r.usage["inputTokens"], 22)


class HostTests(unittest.TestCase):
    def test_assign_requires_hosted_agent_and_model_access(self):
        with tempfile.TemporaryDirectory() as d:
            conn = FakeConn()
            adapter = ScriptedAdapter([final_turn("ok")])
            host = Host(Path(d), "atlas", adapter_factory=lambda _a: adapter)
            host.conn = conn

            async def scenario():
                assign = {"type": "run.assign", "payload": {"run": {"id": "run_9"}, "task": TASK, "agentId": "agt_1"}}
                await host.handle(assign)  # agent not hosted yet
                await host.handle({"type": "welcome", "payload": {"agents": [AGENT], "models": []}})
                await host.handle(assign)  # no model access yet
                await host.handle({"type": "credentials.update", "payload": {"models": [
                    {"provider": "deepseek", "delivery": "gateway", "baseUrl": "http://x/gateway/deepseek", "token": "t",
                     "defaultModel": "deepseek-flash", "models": ["deepseek-flash"]}]}})
                await host.handle(assign)
                await asyncio.gather(*host._tasks.values())

            run(scenario())
            statuses = [(p["status"], p.get("error", {}).get("code")) for p in conn.of("run.status")]
            self.assertEqual(statuses, [("failed", "unknown_agent"), ("paused", "credentials_missing"), ("succeeded", None)])
            self.assertEqual(conn.of("run.accepted"), [{"runId": "run_9"}])
            self.assertEqual(host.runs, {})

    def test_permission_changes_apply_to_running_runs(self):
        with tempfile.TemporaryDirectory() as d:
            class Hanging:
                async def complete(self, *a):
                    await asyncio.sleep(3600)

            host = Host(Path(d), "atlas", adapter_factory=lambda _a: Hanging())
            host.conn = FakeConn()
            models = [{"provider": "deepseek", "delivery": "gateway", "baseUrl": "http://x", "token": "t",
                       "defaultModel": "deepseek-flash", "models": ["deepseek-flash"]}]

            async def scenario():
                await host.handle({"type": "welcome", "payload": {"agents": [AGENT], "models": models}})
                await host.handle({"type": "run.assign", "payload": {"run": {"id": "run_6"}, "task": TASK, "agentId": "agt_1"}})
                self.assertEqual(host.runs["run_6"].tools.policies["write_file"], "ask")
                changed = {**AGENT, "tools": [{"name": "write_file", "policy": "allow"}, {"name": "shell", "policy": "ask"}]}
                await host.handle({"type": "agents.update", "payload": {"agents": [changed]}})
                tools = host.runs["run_6"].tools.policies
                self.assertEqual((tools["write_file"], tools["shell"]), ("allow", "ask"))
                self.assertNotIn("read_file", tools)
                for t in host._tasks.values():
                    t.cancel()
                await asyncio.gather(*host._tasks.values(), return_exceptions=True)

            run(scenario())

    def test_retired_agent_stops_its_run(self):
        with tempfile.TemporaryDirectory() as d:
            conn = FakeConn()

            class Hanging:
                async def complete(self, *a):
                    await asyncio.sleep(3600)

            host = Host(Path(d), "atlas", adapter_factory=lambda _a: Hanging())
            host.conn = conn
            models = [{"provider": "deepseek", "delivery": "gateway", "baseUrl": "http://x", "token": "t",
                       "defaultModel": "deepseek-flash", "models": ["deepseek-flash"]}]

            async def scenario():
                await host.handle({"type": "welcome", "payload": {"agents": [AGENT], "models": models}})
                await host.handle({"type": "run.assign", "payload": {"run": {"id": "run_5"}, "task": TASK, "agentId": "agt_1"}})
                await asyncio.sleep(0.05)
                await host.handle({"type": "agents.update", "payload": {"agents": []}})
                await asyncio.gather(*host._tasks.values(), return_exceptions=True)

            run(scenario())
            self.assertEqual(conn.of("run.status")[-1], {"runId": "run_5", "status": "cancelled"})
            self.assertEqual(host.runs, {})


if __name__ == "__main__":
    unittest.main()
