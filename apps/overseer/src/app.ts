// Wiring between the overseer's parts. Each part gets the App and reaches the others
// through it, which keeps constructors free of circular imports.
import type { Approvals } from "./approvals.js";
import type { Board } from "./board.js";
import type { Core } from "./core.js";
import type { HarnessHub } from "./harness-hub.js";
import type { HelperAgent } from "./helper-agent.js";
import type { OverseerAgent } from "./overseer-agent.js";
import type { Scheduler } from "./scheduler.js";
import type { UiHub } from "./ui-hub.js";
import type { Workers } from "./workers.js";

export interface App {
  core: Core;
  harnesses: HarnessHub;
  ui: UiHub;
  scheduler: Scheduler;
  overseer: OverseerAgent;
  helper: HelperAgent;
  workers: Workers;
  board: Board;
  approvals: Approvals;
  /** Re-apply network settings: rebuild the guard and close connections it no longer allows. */
  onNetworkChange(): void;
  /** Delete all stored data and restart the Overseer (Settings → Remove all data). */
  resetAllData(): void;
}
