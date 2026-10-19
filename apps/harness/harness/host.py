"""The host: runs whatever agents the Overseer spawns on this machine.

The harness itself is not an agent. The Overseer decides how many agents run here
(up to `slots`), what roles they have, and retires them again; this module keeps the
current set (`welcome` / `agents.update`) and runs their tasks.
"""

from __future__ import annotations

import asyncio
import logging
import os
import platform
import socket
from pathlib import Path
from typing import Callable

from . import __version__
from .adapters import Adapter, make_adapter
from .runtime import AgentRun
from .tools import Conn, ToolSet
from .updater import Updater, UpdateError

log = logging.getLogger("harness.host")


class Host:
    def __init__(
        self,
        workdir: Path,
        name: str,
        slots: int = 4,
        adapter_factory: Callable[[dict], Adapter] = make_adapter,
        updater: Updater | None = None,
        token: Callable[[], str | None] = lambda: None,
    ) -> None:
        self.workdir = workdir
        self.name = name
        self.slots = slots
        self.conn: Conn | None = None
        self.agents: dict[str, dict] = {}
        self.models: dict[str, dict] = {}
        self.runs: dict[str, AgentRun] = {}
        self._tasks: dict[str, asyncio.Task] = {}
        self._adapter_factory = adapter_factory
        self.updater = updater
        self._token = token
        self.source_hash = updater.current_hash() if updater else ""
        #: Latest harness.update payload; applied once no runs are active.
        self.pending_update: dict | None = None
        #: Set when the harness should exit (with `exit_code`), e.g. after installing an update.
        self.shutdown = asyncio.Event()
        self.exit_code = 0

    # -- payloads for the connection ---------------------------------------------

    def hello_payload(self) -> dict:
        return {
            "name": self.name,
            "host": socket.gethostname(),
            "os": "windows" if platform.system() == "Windows" else "linux",
            "version": __version__,
            "sourceHash": self.source_hash,
            "capabilities": ["shell", "fs"],
            "slots": self.slots,
            "resumableRuns": [],
        }

    def heartbeat_payload(self) -> dict:
        payload: dict = {"activeRunIds": list(self.runs), "slotsUsed": len(self.runs)}
        if hasattr(os, "getloadavg"):
            payload["load"] = {"cpu": min(1.0, os.getloadavg()[0] / (os.cpu_count() or 1)), "memMb": 0}
        return payload

    # -- messages from the overseer ------------------------------------------------

    async def handle(self, msg: dict) -> None:
        t, p = msg.get("type"), msg.get("payload", {})
        if t == "welcome":
            if self.updater:
                self.updater.commit()  # we reached the overseer: a just-installed update is good
            self.agents = {a["id"]: a for a in p.get("agents", [])}
            self.models = {m["provider"]: m for m in p.get("models", [])}
            log.info("hosting %d agent(s): %s", len(self.agents), ", ".join(a["name"] for a in self.agents.values()) or "none yet")
        elif t == "agents.update":
            self.agents = {a["id"]: a for a in p.get("agents", [])}
            log.info("agents updated: %s", ", ".join(a["name"] for a in self.agents.values()) or "none")
            # A retired agent must not keep working; changed permissions apply right away.
            for run_id, run in list(self.runs.items()):
                if run.agent["id"] in self.agents:
                    run.agent = self.agents[run.agent["id"]]
                    run.tools = ToolSet.from_grants(run.agent.get("tools", []))
                elif run_id in self._tasks:
                    log.info("stopping run %s: agent %s was retired", run_id, run.agent.get("name"))
                    self._tasks[run_id].cancel()
        elif t == "credentials.update":
            self.models = {m["provider"]: m for m in p.get("models", [])}
        elif t == "run.assign":
            await self._assign(p)
        elif t == "run.signal":
            run = self.runs.get(p["runId"])
            if run and p["signal"] == "pause":
                run.pause()
            elif run and p["signal"] == "resume":
                run.resume()
            elif p["signal"] == "cancel" and p["runId"] in self._tasks:
                self._tasks[p["runId"]].cancel()
        elif t == "run.inject":
            if run := self.runs.get(p["runId"]):
                run.inject(p)
        elif t == "operator.rejected":
            if run := self.runs.get(p["runId"]):
                run.inject({"from": "overseer", "content": "Your reply_to_operator was rejected: no open thought window. Use ask_overseer instead."})
        elif t == "harness.update":
            if p.get("sourceHash") == self.source_hash:
                return
            self.pending_update = p
            if self.runs:
                log.info("update %s received; will install after %d active run(s) finish", p.get("version"), len(self.runs))
            else:
                await self.install_pending_update()
        elif t == "run.drop":
            if task := self._tasks.get(p["runId"]):
                task.cancel()
        else:
            log.debug("ignoring %s", t)

    async def _assign(self, p: dict) -> None:
        assert self.conn is not None
        run_id = p["run"]["id"]
        agent = self.agents.get(p["agentId"])
        if agent is None:
            await self.conn.send("run.status", {"runId": run_id, "status": "failed", "error": {"code": "unknown_agent", "message": "agent not hosted here"}})
            return
        if len(self.runs) >= self.slots:
            await self.conn.send("run.status", {"runId": run_id, "status": "failed", "error": {"code": "no_slot", "message": "harness is full"}})
            return

        provider = agent.get("provider") or next(iter(self.models), None)
        access = self.models.get(provider or "")
        if access is None:
            await self.conn.send("run.status", {"runId": run_id, "status": "paused", "error": {"code": "credentials_missing", "message": f"no model access for {provider or 'any provider'}: add an API key in Settings → Model providers"}})
            return

        self.workdir.mkdir(parents=True, exist_ok=True)
        run = AgentRun(
            run_id=run_id, agent=agent, task=p["task"], briefing=p.get("briefing", {}),
            model=agent.get("model") or access["defaultModel"], adapter=self._adapter_factory(access),
            conn=self.conn, workdir=self.workdir, resume_messages=(p.get("resumeFrom") or {}).get("messages"),
            context_window=access.get("contextWindow"),
        )
        self.runs[run_id] = run
        await self.conn.send("run.accepted", {"runId": run_id})
        task = asyncio.create_task(run.run())
        self._tasks[run_id] = task
        task.add_done_callback(lambda _t: self._run_finished(run_id))

    def _run_finished(self, run_id: str) -> None:
        self.runs.pop(run_id, None)
        self._tasks.pop(run_id, None)
        if self.pending_update and not self.runs:
            asyncio.get_running_loop().create_task(self.install_pending_update())

    async def install_pending_update(self) -> None:
        """Download, verify and install the pending update, then ask to be restarted."""
        p, self.pending_update = self.pending_update, None
        if not p or not self.updater or self.runs or self.shutdown.is_set():
            if p and self.runs:
                self.pending_update = p
            return
        assert self.conn is not None
        await self.conn.send("harness.update_status", {"status": "downloading", "sourceHash": p["sourceHash"]})
        try:
            token = self._token()
            if not token:
                raise UpdateError("no harness token")
            package = await self.updater.download(p["url"], token, int(p.get("size", 0)))
            await asyncio.to_thread(self.updater.apply, package, p["sha256"], p["sourceHash"])
        except Exception as e:  # report and keep running the current version
            log.error("update failed: %s", e)
            await self.conn.send("harness.update_status", {"status": "failed", "sourceHash": p["sourceHash"], "error": str(e)})
            return
        log.info("update %s installed; restarting", p.get("version"))
        await self.conn.send("harness.update_status", {"status": "applied", "sourceHash": p["sourceHash"]})
        await asyncio.sleep(0.3)  # let the status message flush
        from .updater import UPDATE_EXIT_CODE

        self.exit_code = UPDATE_EXIT_CODE
        self.shutdown.set()
