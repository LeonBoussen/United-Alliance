// Runs the Overseer (main.ts) as a child process and starts it again when it exits with
// RESTART_EXIT_CODE, e.g. after Settings → Remove all data. Any other exit ends this too.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { RESTART_EXIT_CODE } from "./config.js";

const main = fileURLToPath(new URL("./main.ts", import.meta.url));
let child: ReturnType<typeof spawn> | undefined;

function run(): void {
  // Same node flags (tsx loader, warnings) as this process.
  child = spawn(process.execPath, [...process.execArgv, main], { stdio: "inherit", env: { ...process.env, ALLIANCE_SUPERVISED: "1" } });
  child.on("exit", (code, signal) => {
    if (code === RESTART_EXIT_CODE) return run();
    process.exit(code ?? (signal ? 1 : 0));
  });
}

// Ctrl+C reaches the child from the terminal directly; wait for it to shut down and exit.
// (Forwarding it would be a hard kill on Windows.) SIGTERM comes from kill/service managers.
process.on("SIGINT", () => {});
process.on("SIGTERM", () => child?.kill("SIGTERM"));

run();
