"""One active harness per install folder.

The harness can be started any number of times in the same folder (double-clicked
twice, a scheduled task plus a manual start, …). Only one copy may connect: the first
takes an exclusive OS lock on `.alliance-lock`; every later copy waits in standby,
doing nothing, and retries every few seconds. When the active copy exits or crashes,
the OS releases the lock and one of the waiting copies takes over.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import IO

log = logging.getLogger("harness.instance")

LOCK_FILE = ".alliance-lock"
#: Who holds the lock, for the standby message. A separate file because Windows
#: byte-range locks make the locked file unreadable to other processes.
OWNER_FILE = ".alliance-active"

if os.name == "nt":
    import msvcrt

    def _lock(f: IO[bytes]) -> bool:
        try:
            f.seek(0)
            msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
            return True
        except OSError:
            return False

    def _unlock(f: IO[bytes]) -> None:
        f.seek(0)
        msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
else:
    import fcntl

    def _lock(f: IO[bytes]) -> bool:
        try:
            fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except OSError:
            return False

    def _unlock(f: IO[bytes]) -> None:
        fcntl.flock(f.fileno(), fcntl.LOCK_UN)


class InstanceLock:
    def __init__(self, base_dir: Path) -> None:
        self.base_dir = base_dir
        self._file: IO[bytes] | None = None

    @property
    def held(self) -> bool:
        return self._file is not None

    def try_acquire(self) -> bool:
        if self._file is not None:
            return True
        f = open(self.base_dir / LOCK_FILE, "a+b")
        if not _lock(f):
            f.close()
            return False
        self._file = f
        try:
            (self.base_dir / OWNER_FILE).write_text(
                json.dumps({"pid": os.getpid(), "since": datetime.now(timezone.utc).isoformat()}), encoding="utf-8"
            )
        except OSError:
            pass
        return True

    def owner(self) -> dict:
        try:
            return json.loads((self.base_dir / OWNER_FILE).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    async def wait(self, poll_s: float = 2.0) -> None:
        """Return once this process is the active instance; until then, stand by."""
        if self.try_acquire():
            return
        pid = self.owner().get("pid", "?")
        log.info("another harness is already running in this folder (pid %s); standing by until it stops", pid)
        while not self.try_acquire():
            await asyncio.sleep(poll_s)
        log.info("the previous harness stopped; taking over")

    def release(self) -> None:
        if self._file is None:
            return
        try:
            _unlock(self._file)
        except OSError:
            pass
        self._file.close()
        self._file = None
