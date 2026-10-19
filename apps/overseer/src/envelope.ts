import { randomBytes } from "node:crypto";
import { PROTOCOL_VERSION, type Envelope } from "@alliance/protocol";

export function envelope<T extends string, P>(type: T, payload: P, replyTo?: string): Envelope<T, P> {
  return { v: PROTOCOL_VERSION, id: randomBytes(12).toString("hex"), type, ts: new Date().toISOString(), payload, ...(replyTo ? { replyTo } : {}) };
}
