"""Entry point: `python -m harness` (run from the build folder)."""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from pathlib import Path

from . import __version__
from .config import ConfigError, load
from .instance import InstanceLock


def main() -> int:
    parser = argparse.ArgumentParser(prog="harness", description="United Alliance harness")
    parser.add_argument("--dir", type=Path, default=Path.cwd(), help="folder containing alliance.json")
    parser.add_argument("--slots", type=int, default=8, help="max agents the Overseer may run on this machine at once")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )
    base_dir = args.dir.resolve()
    if not (base_dir / "alliance.json").exists():
        print(f"error: {base_dir / 'alliance.json'} not found. Generate a host build from the console (Hosts → Add host).", file=sys.stderr)
        return 2

    # Only one copy per folder connects; later copies wait here until it stops.
    lock = InstanceLock(base_dir)
    try:
        asyncio.run(lock.wait())
    except KeyboardInterrupt:
        return 0
    try:
        return _run(args, base_dir)
    finally:
        lock.release()


def _run(args: argparse.Namespace, base_dir: Path) -> int:
    # Loaded after taking the lock: the previous instance may have enrolled meanwhile.
    try:
        cfg = load(base_dir)
    except ConfigError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2

    # Imported here so config errors are reported even if dependencies are missing.
    from .connection import Connection, EnrollmentRejected
    from .host import Host

    from .updater import Updater

    assert cfg.workdir is not None
    updater = Updater(cfg.base_dir, cfg.overseer_url)
    host = Host(cfg.workdir, cfg.harness_name, slots=args.slots, updater=updater, token=lambda: cfg.token)
    conn = Connection(cfg, host.handle, host.hello_payload, host.heartbeat_payload)
    host.conn = conn
    logging.getLogger("harness").info(
        "United Alliance host %s (%s), name=%s, overseer=%s",
        __version__, host.source_hash[:12], cfg.harness_name, cfg.overseer_url,
    )

    async def run() -> int:
        connection = asyncio.create_task(conn.run_forever())
        stop = asyncio.create_task(host.shutdown.wait())
        done, pending = await asyncio.wait({connection, stop}, return_when=asyncio.FIRST_COMPLETED)
        for t in pending:
            t.cancel()
        for t in done:
            t.result()  # re-raise EnrollmentRejected etc.
        return host.exit_code

    try:
        return asyncio.run(run())
    except EnrollmentRejected as e:
        print(f"error: the Overseer rejected this harness ({e}). Generate a new build from the console.", file=sys.stderr)
        return 3
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
