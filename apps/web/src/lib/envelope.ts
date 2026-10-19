import { PROTOCOL_VERSION, type Envelope } from "@alliance/protocol";

export function newId(prefix = ""): string {
  const raw = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  return prefix ? `${prefix}_${raw}` : raw;
}

export function envelope<T extends string, P>(type: T, payload: P, replyTo?: string): Envelope<T, P> {
  return { v: PROTOCOL_VERSION, id: newId(), type, ts: new Date().toISOString(), payload, ...(replyTo ? { replyTo } : {}) };
}
