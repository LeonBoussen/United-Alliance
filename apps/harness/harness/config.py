"""Harness configuration.

`alliance.json` ships in the site-generated build: overseer URL, harness name and a
single-use enrollment token. After enrollment the permanent harness token lives in
`.alliance-state` (owner-only) and the enrollment token is removed from alliance.json.
Nothing about agents or model keys is configured here: the Overseer sends those.
"""

from __future__ import annotations

import json
import os
import socket
import stat
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

CONFIG_FILE = "alliance.json"
STATE_FILE = ".alliance-state"


class ConfigError(Exception):
    pass


@dataclass
class Config:
    base_dir: Path
    overseer_url: str
    harness_name: str
    build_id: str | None = None
    enrollment_token: str | None = None
    token: str | None = None
    harness_id: str | None = None
    #: Root directory tools may read/write. Defaults to <base_dir>/workspace.
    workdir: Path | None = None

    @property
    def ws_url(self) -> str:
        u = urlparse(self.overseer_url)
        if u.scheme not in ("http", "https"):
            raise ConfigError(f"overseer_url must start with http:// or https:// (got {self.overseer_url!r})")
        scheme = "wss" if u.scheme == "https" else "ws"
        return f"{scheme}://{u.netloc}{u.path.rstrip('/')}/ws/harness"


def load(base_dir: Path) -> Config:
    path = base_dir / CONFIG_FILE
    if not path.exists():
        raise ConfigError(f"{path} not found. Generate a build from the console (Agents → New agent).")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise ConfigError(f"{path} is not valid JSON: {e}") from e
    if not isinstance(raw, dict) or not isinstance(raw.get("overseer_url"), str):
        raise ConfigError(f"{path} must contain an 'overseer_url' string")

    state: dict = {}
    state_path = base_dir / STATE_FILE
    if state_path.exists():
        try:
            state = json.loads(state_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            raise ConfigError(f"{state_path} is corrupt: {e}. Delete it and re-enroll with a new build.") from e

    workdir = Path(raw["workdir"]) if raw.get("workdir") else base_dir / "workspace"
    cfg = Config(
        base_dir=base_dir,
        overseer_url=raw["overseer_url"],
        harness_name=str(raw.get("harness_name") or socket.gethostname()),
        build_id=raw.get("build_id"),
        enrollment_token=raw.get("enrollment_token") or None,
        token=state.get("token"),
        harness_id=state.get("harness_id"),
        workdir=workdir.resolve(),
    )
    if not cfg.token and not cfg.enrollment_token:
        raise ConfigError("No harness token and no enrollment token. Generate a new build from the console.")
    cfg.ws_url  # validate early
    return cfg


def save_enrollment(cfg: Config, harness_id: str, token: str) -> None:
    """Persist the permanent token and drop the single-use enrollment token."""
    state_path = cfg.base_dir / STATE_FILE
    state_path.write_text(json.dumps({"harness_id": harness_id, "token": token}), encoding="utf-8")
    try:
        os.chmod(state_path, stat.S_IRUSR | stat.S_IWUSR)  # owner-only on POSIX; best effort on Windows
    except OSError:
        pass

    cfg_path = cfg.base_dir / CONFIG_FILE
    raw = json.loads(cfg_path.read_text(encoding="utf-8"))
    raw.pop("enrollment_token", None)
    cfg_path.write_text(json.dumps(raw, indent=2), encoding="utf-8")

    cfg.token, cfg.harness_id, cfg.enrollment_token = token, harness_id, None
