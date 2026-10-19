"""WebSocket connection to the Overseer (docs/PROTOCOL.md §2).

Handles enrollment, heartbeats, reconnect with backoff, an outbox that buffers
messages while offline, and request/reply matching by `replyTo`.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import uuid
from collections import deque
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

import websockets

from . import PROTOCOL_VERSION
from .config import Config, save_enrollment

log = logging.getLogger("harness.connection")

Handler = Callable[[dict], Awaitable[None]]


class EnrollmentRejected(Exception):
    """The Overseer refused our token (bad, used, expired or revoked)."""


def envelope(type_: str, payload: dict, reply_to: str | None = None) -> dict:
    env = {
        "v": PROTOCOL_VERSION,
        "id": uuid.uuid4().hex,
        "type": type_,
        "ts": datetime.now(timezone.utc).isoformat(),
        "payload": payload,
    }
    if reply_to:
        env["replyTo"] = reply_to
    return env


class Connection:
    def __init__(
        self,
        cfg: Config,
        on_message: Handler,
        hello_payload: Callable[[], dict],
        heartbeat_payload: Callable[[], dict],
    ) -> None:
        self.cfg = cfg
        self._on_message = on_message
        self._hello_payload = hello_payload
        self._heartbeat_payload = heartbeat_payload
        self._ws: Any = None
        self._outbox: deque[dict] = deque(maxlen=10_000)
        self._pending: dict[str, asyncio.Future] = {}
        self._connected = asyncio.Event()

    # -- public API -----------------------------------------------------------

    async def send(self, type_: str, payload: dict, reply_to: str | None = None) -> str:
        msg = envelope(type_, payload, reply_to)
        await self._send_raw(msg)
        return msg["id"]

    async def request(self, type_: str, payload: dict, timeout: float | None = None) -> dict:
        """Send and wait for the message whose replyTo matches. Returns its payload."""
        msg = envelope(type_, payload)
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[msg["id"]] = fut
        try:
            await self._send_raw(msg)
            return await asyncio.wait_for(fut, timeout)
        finally:
            self._pending.pop(msg["id"], None)

    async def run_forever(self) -> None:
        attempt = 0
        while True:
            try:
                await self._session()
                attempt = 0
            except EnrollmentRejected:
                raise
            except (OSError, websockets.exceptions.WebSocketException) as e:
                log.warning("connection lost: %s", e)
            self._connected.clear()
            self._ws = None
            delay = min(30.0, 0.5 * 2**attempt) * random.uniform(0.75, 1.25)
            attempt += 1
            log.info("reconnecting in %.1fs", delay)
            await asyncio.sleep(delay)

    # -- internals ------------------------------------------------------------

    async def _send_raw(self, msg: dict) -> None:
        if self._ws is not None and self._connected.is_set():
            try:
                await self._ws.send(json.dumps(msg))
                return
            except websockets.exceptions.ConnectionClosed:
                pass
        self._outbox.append(msg)

    async def _session(self) -> None:
        log.info("connecting to %s", self.cfg.ws_url)
        async with websockets.connect(self.cfg.ws_url, max_size=16 * 1024 * 1024) as ws:
            self._ws = ws
            hello = self._hello_payload()
            if self.cfg.token:
                hello["token"] = self.cfg.token
            else:
                hello["enrollmentToken"] = self.cfg.enrollment_token
            await ws.send(json.dumps(envelope("hello", hello)))

            try:
                welcome = json.loads(await asyncio.wait_for(ws.recv(), 30))
            except websockets.exceptions.ConnectionClosed as e:
                if e.rcvd and e.rcvd.code == 4401:
                    raise EnrollmentRejected(e.rcvd.reason or "token rejected") from e
                raise
            if welcome.get("type") != "welcome":
                raise websockets.exceptions.ProtocolError(f"expected welcome, got {welcome.get('type')}")

            p = welcome["payload"]
            if p.get("harnessToken"):
                save_enrollment(self.cfg, p["harnessId"], p["harnessToken"])
                log.info("enrolled as %s", p["harnessId"])
            self._connected.set()
            await self._on_message(welcome)

            while self._outbox:  # replay what we buffered while offline, in order
                await ws.send(json.dumps(self._outbox.popleft()))

            heartbeat = asyncio.create_task(self._heartbeat(p.get("heartbeatMs", 10_000) / 1000))
            try:
                async for raw in ws:
                    await self._dispatch(json.loads(raw))
            finally:
                heartbeat.cancel()

    async def _dispatch(self, msg: dict) -> None:
        reply_to = msg.get("replyTo")
        if reply_to and reply_to in self._pending:
            fut = self._pending[reply_to]
            if not fut.done():
                fut.set_result(msg.get("payload", {}))
            return
        try:
            await self._on_message(msg)
        except Exception:  # one bad message must not kill the connection
            log.exception("error handling %s", msg.get("type"))

    async def _heartbeat(self, interval: float) -> None:
        while True:
            await asyncio.sleep(interval)
            await self.send("heartbeat", self._heartbeat_payload())
