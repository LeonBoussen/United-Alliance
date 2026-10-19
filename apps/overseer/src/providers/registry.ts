// Model providers the overseer knows about. Model names live here (and can be
// overridden in Settings) so they never need to be hard-coded in the harness.
import type { ProviderId, ProviderSettings } from "@alliance/protocol";

export interface ProviderDefinition {
  id: ProviderId;
  label: string;
  /** False until the harness adapter and gateway route exist. */
  available: boolean;
  /** API wire format the gateway forwards unchanged. */
  format: "openai-chat" | "anthropic-messages" | "openai-responses";
  baseUrl: string;
  defaultModel: string;
  models: string[];
  /** Context window in tokens. Harnesses compact runs before reaching it; a smaller real limit is learned from the provider's error. */
  contextWindow: number;
  /** How the real key is attached when the gateway forwards a request. */
  auth: { header: "authorization"; scheme: "Bearer" } | { header: "x-api-key" };
  /** Cheap request used by "Test connection". */
  testPath: string;
  /** Env var that overrides the stored key at boot. */
  envKey: string;
}

export const PROVIDERS: Record<ProviderId, ProviderDefinition> = {
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    available: true,
    format: "openai-chat",
    baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-flash",
    models: ["deepseek-flash", "deepseek-v4-pro"],
    contextWindow: 128_000,
    auth: { header: "authorization", scheme: "Bearer" },
    testPath: "/models",
    envKey: "ALLIANCE_DEEPSEEK_API_KEY",
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic (Claude)",
    available: false,
    format: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    defaultModel: "claude-opus-5-5",
    models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
    contextWindow: 200_000,
    auth: { header: "x-api-key" },
    testPath: "/v1/models",
    envKey: "ALLIANCE_ANTHROPIC_API_KEY",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    available: false,
    format: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "",
    models: [],
    contextWindow: 128_000,
    auth: { header: "authorization", scheme: "Bearer" },
    testPath: "/models",
    envKey: "ALLIANCE_OPENAI_API_KEY",
  },
};

/** Default provider settings for a fresh install: DeepSeek on, the rest "coming later". */
export function defaultProviderSettings(): ProviderSettings[] {
  return Object.values(PROVIDERS).map((p) => ({
    id: p.id,
    label: p.label,
    available: p.available,
    enabled: p.id === "deepseek",
    baseUrl: p.baseUrl,
    defaultModel: p.defaultModel,
    models: p.models,
    keySet: false,
  }));
}

/** Short, non-reversible hint shown in the console instead of the key. */
export function keyHint(apiKey: string): string {
  const k = apiKey.trim();
  if (k.length <= 8) return "••••";
  const prefix = k.match(/^[a-z]+-/i)?.[0] ?? "";
  return `${prefix}…${k.slice(-4)}`;
}
