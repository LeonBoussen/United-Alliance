// Generates host builds (DESIGN §4.4): the Python harness plus OS-specific start,
// service and install scripts, and an alliance.json with a single-use enrollment token.
// A build is a host, not an agent: the Overseer spawns agents on it once it connects.
// Used by the overseer (sources read from apps/harness on disk) and by the demo console
// (sources bundled by Vite), so both produce identical packages.
import { zipSync, strToU8 } from "fflate";
import type { BuildOs, HarnessBuild } from "@alliance/protocol";

export interface BuildInput {
  build: Pick<HarnessBuild, "id" | "os" | "harnessName" | "overseerUrl" | "downloadUrl">;
  enrollmentToken: string;
}

/** Harness sources keyed by path relative to apps/harness, e.g. "harness/host.py". */
export type HarnessSources = Record<string, string>;

export interface BuildFile {
  path: string;
  content: string;
  executable?: boolean;
}

export class BuildInputError extends Error {}

export function slugify(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return slug || "harness";
}

export function folderName(harnessName: string): string {
  return `united-alliance-${slugify(harnessName)}`;
}

/** Values end up inside shell/PowerShell scripts, so only plain http(s) URLs are accepted. */
function checkUrl(label: string, value: string): string {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new BuildInputError(`${label} is not a valid URL: ${value}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new BuildInputError(`${label} must be http(s)`);
  if (/["'`$\\\s;&|<>]/.test(value)) throw new BuildInputError(`${label} contains characters that aren't allowed`);
  return value;
}

function checkToken(token: string): string {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) throw new BuildInputError("enrollment token has an unexpected format");
  return token;
}

// -- scripts -------------------------------------------------------------------

const crlf = (s: string) => s.replace(/\r?\n/g, "\r\n");

function startCmd(): string {
  return crlf(`@echo off
setlocal
title United Alliance harness
cd /d "%~dp0"

set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (
  where python >nul 2>nul && set "PY=python"
)
if not defined PY (
  echo Python 3.10 or newer is required: https://www.python.org/downloads/
  if not "%UA_SERVICE%"=="1" pause
  exit /b 1
)
%PY% -c "import sys; sys.exit(sys.version_info < (3, 10))"
if errorlevel 1 (
  echo Python 3.10 or newer is required. Found:
  %PY% --version
  if not "%UA_SERVICE%"=="1" pause
  exit /b 1
)

if not exist ".venv\\Scripts\\python.exe" (
  echo First run: creating a virtual environment and installing requirements...
  %PY% -m venv .venv
  if errorlevel 1 goto fail
  ".venv\\Scripts\\python.exe" -m pip install --disable-pip-version-check -q -r requirements.txt
  if errorlevel 1 goto fail
)

:run
".venv\\Scripts\\python.exe" -m harness %*
set "CODE=%errorlevel%"
rem 75 = the harness installed an update and wants a restart.
if "%CODE%"=="75" (
  echo Restarting with the updated harness...
  ".venv\\Scripts\\python.exe" -m pip install --disable-pip-version-check -q -r requirements.txt
  goto run
)
rem Crashed right after an update: roll back to the previous version and retry.
if exist ".update-pending" if exist ".update-backup\\harness" (
  echo The updated harness failed to start. Rolling back...
  rmdir /s /q harness
  move ".update-backup\\harness" harness >nul
  if exist ".update-backup\\requirements.txt" move /y ".update-backup\\requirements.txt" requirements.txt >nul
  rmdir /s /q .update-backup
  del .update-pending
  goto run
)
if not "%UA_SERVICE%"=="1" pause
exit /b %CODE%

:fail
echo Setup failed. Delete the .venv folder and try again.
if not "%UA_SERVICE%"=="1" pause
exit /b 1
`);
}

function installServicePs1(slug: string): string {
  return crlf(`# Runs this harness automatically when you log in (Windows Task Scheduler).
# Usage:  powershell -ExecutionPolicy Bypass -File install-service.ps1 [-Uninstall]
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$name = 'UnitedAlliance-${slug}'
if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false
  Write-Host "Removed scheduled task $name"
  exit 0
}
$dir = $PSScriptRoot
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c set UA_SERVICE=1&& \`"$dir\\start.cmd\`"" -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Description 'United Alliance harness' -Force | Out-Null
Start-ScheduledTask -TaskName $name
Write-Host "Installed and started scheduled task $name"
`);
}

function startSh(): string {
  return `#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

PY="$(command -v python3 || command -v python || true)"
if [ -z "$PY" ]; then
  echo "Python 3.10 or newer is required (e.g. sudo apt install python3 python3-venv)" >&2
  exit 1
fi
if ! "$PY" -c 'import sys; sys.exit(sys.version_info < (3, 10))'; then
  echo "Python 3.10 or newer is required. Found: $("$PY" --version)" >&2
  exit 1
fi

if [ ! -x .venv/bin/python ]; then
  echo "First run: creating a virtual environment and installing requirements..."
  if ! "$PY" -m venv .venv; then
    echo "Could not create a virtual environment. On Debian/Ubuntu: sudo apt install python3-venv" >&2
    rm -rf .venv
    exit 1
  fi
  .venv/bin/python -m pip install --disable-pip-version-check -q -r requirements.txt
fi

while true; do
  set +e
  .venv/bin/python -m harness "$@"
  code=$?
  set -e
  if [ "$code" -eq 75 ]; then
    # The harness installed an update and wants a restart.
    echo "Restarting with the updated harness..."
    .venv/bin/python -m pip install --disable-pip-version-check -q -r requirements.txt
    continue
  fi
  if [ -f .update-pending ] && [ -d .update-backup/harness ]; then
    # Crashed right after an update: roll back to the previous version and retry.
    echo "The updated harness failed to start. Rolling back..." >&2
    rm -rf harness
    mv .update-backup/harness harness
    [ -f .update-backup/requirements.txt ] && mv -f .update-backup/requirements.txt requirements.txt
    rm -rf .update-backup .update-pending
    continue
  fi
  exit "$code"
done
`;
}

function installServiceSh(slug: string): string {
  return `#!/usr/bin/env bash
# Runs this harness as a systemd user service (starts at boot with lingering enabled).
# Usage:  ./install-service.sh [--uninstall]
set -euo pipefail
NAME="united-alliance-${slug}"
UNIT="$HOME/.config/systemd/user/$NAME.service"
if [ "\${1:-}" = "--uninstall" ]; then
  systemctl --user disable --now "$NAME" || true
  rm -f "$UNIT"
  systemctl --user daemon-reload
  echo "Removed $NAME"
  exit 0
fi
DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$(dirname "$UNIT")"
cat > "$UNIT" <<UNIT
[Unit]
Description=United Alliance harness ($NAME)
After=network-online.target

[Service]
WorkingDirectory=$DIR
ExecStart=$DIR/start.sh
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now "$NAME"
echo "Installed and started $NAME"
echo "To keep it running after logout: sudo loginctl enable-linger $USER"
`;
}

function readme(input: BuildInput, os: BuildOs): string {
  const start = os === "windows" ? "start.cmd" : "./start.sh";
  const service = os === "windows" ? "powershell -ExecutionPolicy Bypass -File install-service.ps1" : "./install-service.sh";
  return `United Alliance host: ${input.build.harnessName}
Overseer: ${input.build.overseerUrl}

This is a host, not an agent. Once it is connected, the Overseer spawns as many agents
on it as it needs (up to 8 at once by default; start it with --slots N to change that),
gives each a role, and retires them when they finish, fail or sit idle.

Only one copy runs per folder. If you start it again while it is running, the new copy
waits in standby and takes over when the running one stops.

Requirements: Python 3.10+ (${os === "windows" ? "https://www.python.org/downloads/" : "python3 and python3-venv"}).

Run it:            ${start}
Run at login/boot: ${service}

On first start the harness enrolls with the Overseer using the one-time token in
alliance.json (valid for 24 hours). After that it stores its own token in
.alliance-state and the enrollment token is removed. This package contains no API
keys: the Overseer provides model access.

Agents can read and write files only inside the "workspace" folder next to this file.
`;
}

// -- public API ----------------------------------------------------------------

/**
 * The files that make up "the harness code": harness/**.py and requirements.txt, sorted
 * by path (byte order). Builds, update packages and the source hash all use this set;
 * the harness hashes the same set on disk (harness/updater.py).
 */
export function harnessSourceFiles(sources: HarnessSources): BuildFile[] {
  return Object.entries(sources)
    .filter(([path]) => (path.startsWith("harness/") && path.endsWith(".py")) || path === "requirements.txt")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, content]) => ({ path, content }));
}

/** Update package: just the harness code, no config (DESIGN §4.5). */
export function zipUpdatePackage(sources: HarnessSources): Uint8Array {
  return zipBuild(harnessSourceFiles(sources));
}

/** The files of a build, all under one top-level folder. */
export function generateBuildFiles(input: BuildInput, sources: HarnessSources): BuildFile[] {
  const overseerUrl = checkUrl("Overseer URL", input.build.overseerUrl);
  const token = checkToken(input.enrollmentToken);
  const slug = slugify(input.build.harnessName);
  const root = folderName(input.build.harnessName);
  const os = input.build.os;

  const files: BuildFile[] = harnessSourceFiles(sources);
  if (!files.some((f) => f.path === "harness/__main__.py")) throw new BuildInputError("harness sources are missing harness/__main__.py");

  files.push({
    path: "alliance.json",
    content:
      JSON.stringify(
        { overseer_url: overseerUrl, harness_name: input.build.harnessName, build_id: input.build.id, enrollment_token: token },
        null,
        2,
      ) + "\n",
  });
  files.push({ path: "README.txt", content: os === "windows" ? crlf(readme(input, os)) : readme(input, os) });
  if (os === "windows") {
    files.push({ path: "start.cmd", content: startCmd() });
    files.push({ path: "install-service.ps1", content: installServicePs1(slug) });
  } else {
    files.push({ path: "start.sh", content: startSh(), executable: true });
    files.push({ path: "install-service.sh", content: installServiceSh(slug), executable: true });
  }
  return files.map((f) => ({ ...f, path: `${root}/${f.path}` }));
}

/** Zip a build. Executable bits are set for the Linux scripts. */
export function zipBuild(files: BuildFile[]): Uint8Array {
  const entries: Record<string, [Uint8Array, { os?: number; attrs?: number }]> = {};
  for (const f of files) {
    entries[f.path] = [strToU8(f.content), f.executable ? { os: 3, attrs: (0o100755 << 16) >>> 0 } : {}];
  }
  return zipSync(entries, { level: 6 });
}

/** One-line install command shown in the console for a build. */
export function installCommand(build: Pick<HarnessBuild, "id" | "os">, overseerUrl: string, enrollmentToken: string): string {
  const base = `${checkUrl("Overseer URL", overseerUrl).replace(/\/$/, "")}/api/builds/${build.id}`;
  const t = encodeURIComponent(checkToken(enrollmentToken));
  return build.os === "windows"
    ? `powershell -ExecutionPolicy Bypass -c "irm '${base}/install.ps1?t=${t}' | iex"`
    : `curl -fsSL '${base}/install.sh?t=${t}' | bash`;
}

/** Body of the install.ps1 / install.sh endpoints: download the zip, unpack, start. */
export function installScript(build: Pick<HarnessBuild, "os" | "harnessName" | "downloadUrl">): string {
  const url = checkUrl("download URL", build.downloadUrl);
  const root = folderName(build.harnessName);
  if (build.os === "windows") {
    return crlf(`$ErrorActionPreference = 'Stop'
$parent = Join-Path $env:LOCALAPPDATA 'UnitedAlliance'
$zip = Join-Path $env:TEMP '${root}.zip'
New-Item -ItemType Directory -Force -Path $parent | Out-Null
Write-Host 'Downloading United Alliance harness...'
Invoke-WebRequest -UseBasicParsing -Uri '${url}' -OutFile $zip
Expand-Archive -Force -Path $zip -DestinationPath $parent
Remove-Item $zip
$dir = Join-Path $parent '${root}'
Write-Host "Installed to $dir"
Start-Process -FilePath (Join-Path $dir 'start.cmd') -WorkingDirectory $dir
`);
  }
  return `#!/usr/bin/env bash
set -euo pipefail
PARENT="\${XDG_DATA_HOME:-$HOME/.local/share}/united-alliance"
ZIP="$(mktemp --suffix=.zip)"
mkdir -p "$PARENT"
echo "Downloading United Alliance harness..."
curl -fsSL '${url}' -o "$ZIP"
python3 -m zipfile -e "$ZIP" "$PARENT"
rm -f "$ZIP"
chmod +x "$PARENT/${root}/start.sh" "$PARENT/${root}/install-service.sh"
echo "Installed to $PARENT/${root}"
exec "$PARENT/${root}/start.sh"
`;
}
