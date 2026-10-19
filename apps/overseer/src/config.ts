// Boot-time configuration from environment variables (DESIGN §5a.3). Everything else is
// a setting stored in the database and editable from the console.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

/** Exit code that asks the supervisor to start the Overseer again (same as the harness). */
export const RESTART_EXIT_CODE = 75;

/** Files the Overseer keeps in its data directory. */
export const DATA_FILES = ["overseer.db", "overseer.db-wal", "overseer.db-shm", "master.key"];

export interface Config {
  port: number;
  bindHost: string;
  dataDir: string;
  /** Env overrides; a setting fixed here shows as locked in the console. */
  allowPublic?: boolean;
  deepseekApiKey?: string;
  masterKey?: string;
  /** Built console (apps/web/dist), served at /. */
  webDist: string;
  /** Python harness sources (apps/harness), used for builds and updates. */
  harnessDir: string;
}

function bool(v: string | undefined): boolean | undefined {
  if (v === undefined || v === "") return undefined;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.ALLIANCE_PORT || 8080);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`ALLIANCE_PORT is not a valid port: ${env.ALLIANCE_PORT}`);
  return {
    port,
    bindHost: env.ALLIANCE_BIND || "0.0.0.0",
    dataDir: resolve(env.ALLIANCE_DATA_DIR || resolve(here, "../data")),
    allowPublic: bool(env.ALLIANCE_ALLOW_PUBLIC),
    deepseekApiKey: env.ALLIANCE_DEEPSEEK_API_KEY || undefined,
    masterKey: env.ALLIANCE_MASTER_KEY || undefined,
    webDist: resolve(env.ALLIANCE_WEB_DIST || resolve(here, "../../web/dist")),
    harnessDir: resolve(env.ALLIANCE_HARNESS_DIR || resolve(here, "../../harness")),
  };
}
