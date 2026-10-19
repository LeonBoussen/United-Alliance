import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { strFromU8, unzipSync } from "fflate";
import { BuildInputError, generateBuildFiles, installCommand, installScript, slugify, zipBuild, type BuildInput } from "./index.js";

// Real harness sources from apps/harness, as the overseer would read them.
const harnessDir = fileURLToPath(new URL("../../../apps/harness/", import.meta.url));
function readSources(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name !== "__pycache__" && name !== ".venv") walk(p);
      } else out[relative(harnessDir, p).replace(/\\/g, "/")] = readFileSync(p, "utf8");
    }
  };
  walk(harnessDir);
  return out;
}

const TOKEN = "enr_0123456789abcdef0123";
const input = (os: "windows" | "linux", overseerUrl = "http://192.168.1.20:8080"): BuildInput => ({
  build: { id: "bld_1", os, harnessName: "Atlas Workstation", overseerUrl, downloadUrl: `${overseerUrl}/api/builds/bld_1/download?t=${TOKEN}` },
  enrollmentToken: TOKEN,
});

test("windows build: python sources, start.cmd, service script, config with token", () => {
  const files = generateBuildFiles(input("windows"), readSources());
  const paths = files.map((f) => f.path);
  const root = "united-alliance-atlas-workstation/";
  assert.ok(paths.every((p) => p.startsWith(root)));
  for (const p of ["harness/__main__.py", "harness/runtime.py", "harness/adapters/deepseek.py", "requirements.txt", "start.cmd", "install-service.ps1", "alliance.json", "README.txt"]) {
    assert.ok(paths.includes(root + p), `missing ${p}`);
  }
  assert.ok(!paths.some((p) => p.includes("tests/") || p.endsWith(".sh")), "no tests or linux scripts in a windows build");

  const cfg = JSON.parse(files.find((f) => f.path.endsWith("alliance.json"))!.content);
  assert.deepEqual(cfg, { overseer_url: "http://192.168.1.20:8080", harness_name: "Atlas Workstation", build_id: "bld_1", enrollment_token: TOKEN });
  assert.ok(files.find((f) => f.path.endsWith("start.cmd"))!.content.includes("\r\n"), "batch files use CRLF");
  assert.ok(!JSON.stringify(files).match(/sk-[A-Za-z0-9]{8,}/), "no API keys in the package");
});

test("linux build: executable scripts survive the zip", () => {
  const files = generateBuildFiles(input("linux"), readSources());
  assert.ok(files.some((f) => f.path.endsWith("start.sh") && f.executable));
  assert.ok(!files.some((f) => f.path.endsWith(".cmd") || f.path.endsWith(".ps1")));

  const unzipped = unzipSync(zipBuild(files));
  assert.equal(Object.keys(unzipped).length, files.length);
  const start = strFromU8(unzipped["united-alliance-atlas-workstation/start.sh"]!);
  assert.ok(start.startsWith("#!/usr/bin/env bash"));
  assert.ok(!start.includes("\r"), "shell scripts use LF");
});

test("install commands and scripts", () => {
  assert.equal(
    installCommand({ id: "bld_1", os: "linux" }, "http://192.168.1.20:8080/", TOKEN),
    `curl -fsSL 'http://192.168.1.20:8080/api/builds/bld_1/install.sh?t=${TOKEN}' | bash`,
  );
  assert.match(installCommand({ id: "bld_1", os: "windows" }, "http://10.0.0.5:8080", TOKEN), /^powershell .*irm '.*install\.ps1\?t=.*' \| iex"$/);
  const ps = installScript({ os: "windows", harnessName: "Atlas", downloadUrl: "http://10.0.0.5:8080/api/builds/bld_1/download?t=abc" });
  assert.ok(ps.includes("Expand-Archive") && ps.includes("united-alliance-atlas"));
  const sh = installScript({ os: "linux", harnessName: "Atlas", downloadUrl: "http://10.0.0.5:8080/api/builds/bld_1/download?t=abc" });
  assert.ok(sh.includes("python3 -m zipfile -e"));
});

test("rejects values that could break out of the scripts", () => {
  const src = readSources();
  assert.throws(() => generateBuildFiles(input("linux", "http://x.lan/'; rm -rf ~; echo '"), src), BuildInputError);
  assert.throws(() => generateBuildFiles(input("windows", "file:///etc/passwd"), src), BuildInputError);
  assert.throws(() => generateBuildFiles({ ...input("linux"), enrollmentToken: "short" }, src), BuildInputError);
  assert.throws(() => generateBuildFiles(input("linux"), {}), BuildInputError);
  assert.equal(slugify("  ../Évil Name!! "), "vil-name");
  assert.equal(slugify("***"), "harness");
});
