// Tools a harness can offer, mirrored from apps/harness/harness/tools.py (keep in sync).
import type { Risk, ToolPolicy } from "@alliance/protocol";

export interface CatalogTool {
  name: string;
  label: string;
  description: string;
  defaultPolicy: ToolPolicy;
  /** Same as the harness's built-in risk; agents and defaults can override it. */
  defaultRisk: Risk;
}

/** Environment tools: granted per agent with a policy. */
export const ENVIRONMENT_TOOLS: CatalogTool[] = [
  { name: "shell", label: "Shell", description: "Run commands in the agent's workspace", defaultPolicy: "ask", defaultRisk: "medium" },
  { name: "read_file", label: "Read files", description: "Read text files in the workspace", defaultPolicy: "allow", defaultRisk: "low" },
  { name: "write_file", label: "Write files", description: "Create or overwrite files in the workspace", defaultPolicy: "ask", defaultRisk: "medium" },
  { name: "list_dir", label: "List folders", description: "List directories in the workspace", defaultPolicy: "allow", defaultRisk: "low" },
];

/** Alliance tools: always on, they only talk to the Overseer. */
export const ALLIANCE_TOOLS = ["ask_overseer", "request_context", "report_progress", "remember", "reply_to_operator", "board_read", "board_post", "update_self"];
