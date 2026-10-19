"""Self-update (DESIGN §4.5).

The Overseer announces new harness code with `harness.update`. We download the package,
check its sha256 and the hash of its contents, move the current code to
`.update-backup/`, put the new code in place, mark `.update-pending` and exit with
UPDATE_EXIT_CODE. The start script restarts us; if the new version crashes before it
reaches the Overseer, the start script restores the backup. After a successful
welcome we `commit()` and delete the backup.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import logging
import shutil
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath

log = logging.getLogger("harness.updater")

UPDATE_EXIT_CODE = 75
STAGING = ".update-staging"
BACKUP = ".update-backup"
PENDING = ".update-pending"
MAX_PACKAGE = 20 * 1024 * 1024


class UpdateError(Exception):
    pass


def _source_files(root: Path) -> list[tuple[str, Path]]:
    files = [(p.relative_to(root).as_posix(), p) for p in (root / "harness").rglob("*.py") if "__pycache__" not in p.parts]
    req = root / "requirements.txt"
    if req.exists():
        files.append(("requirements.txt", req))
    return sorted(files, key=lambda f: f[0].encode())


def source_hash(root: Path) -> str:
    """sha256 over the harness code; must match the overseer's computation (harness-kit file set)."""
    h = hashlib.sha256()
    for rel, path in _source_files(root):
        h.update(rel.encode() + b"\n" + path.read_bytes() + b"\n")
    return h.hexdigest()


def _safe_member(name: str) -> bool:
    p = PurePosixPath(name)
    if p.is_absolute() or ".." in p.parts:
        return False
    return (p.parts[0] == "harness" and p.suffix == ".py") or name == "requirements.txt"


class Updater:
    def __init__(self, root: Path, overseer_url: str) -> None:
        self.root = root
        self.overseer_url = overseer_url.rstrip("/")

    def current_hash(self) -> str:
        return source_hash(self.root)

    async def download(self, url: str, token: str, expected_size: int) -> bytes:
        full = url if url.startswith("http") else self.overseer_url + url
        if expected_size > MAX_PACKAGE:
            raise UpdateError("package too large")

        def fetch() -> bytes:
            req = urllib.request.Request(full, headers={"Authorization": f"Bearer {token}"})
            with urllib.request.urlopen(req, timeout=120) as resp:  # noqa: S310 - URL comes from our overseer
                return resp.read(MAX_PACKAGE + 1)

        data = await asyncio.to_thread(fetch)
        if len(data) > MAX_PACKAGE:
            raise UpdateError("package too large")
        return data

    def apply(self, package: bytes, sha256: str, expected_source_hash: str) -> None:
        if hashlib.sha256(package).hexdigest() != sha256:
            raise UpdateError("package checksum mismatch")

        staging = self.root / STAGING
        shutil.rmtree(staging, ignore_errors=True)
        staging.mkdir()
        try:
            with zipfile.ZipFile(io.BytesIO(package)) as zf:
                for name in zf.namelist():
                    if name.endswith("/"):
                        continue
                    if not _safe_member(name):
                        raise UpdateError(f"unexpected file in package: {name}")
                    target = staging / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(zf.read(name))
            if not (staging / "harness" / "__main__.py").exists():
                raise UpdateError("package has no harness/__main__.py")
            if source_hash(staging) != expected_source_hash:
                raise UpdateError("package contents don't match the announced version")

            backup = self.root / BACKUP
            shutil.rmtree(backup, ignore_errors=True)
            backup.mkdir()
            (self.root / "harness").rename(backup / "harness")
            try:
                if (self.root / "requirements.txt").exists():
                    (self.root / "requirements.txt").rename(backup / "requirements.txt")
                (staging / "harness").rename(self.root / "harness")
                if (staging / "requirements.txt").exists():
                    (staging / "requirements.txt").rename(self.root / "requirements.txt")
            except OSError:
                # Put the old code back before reporting the failure.
                if not (self.root / "harness").exists():
                    (backup / "harness").rename(self.root / "harness")
                if (backup / "requirements.txt").exists() and not (self.root / "requirements.txt").exists():
                    (backup / "requirements.txt").rename(self.root / "requirements.txt")
                raise
            (self.root / PENDING).write_text(expected_source_hash, encoding="utf-8")
        finally:
            shutil.rmtree(staging, ignore_errors=True)

    def commit(self) -> None:
        """Called once the (possibly new) version has reached the Overseer."""
        pending = self.root / PENDING
        if pending.exists():
            pending.unlink()
            shutil.rmtree(self.root / BACKUP, ignore_errors=True)
            log.info("update committed")
