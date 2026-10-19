import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const newId = (prefix: string) => `${prefix}_${randomBytes(8).toString("hex")}`;

/** URL-safe secret token. Matches the harness-kit token format. */
export const newToken = (prefix: string) => `${prefix}_${randomBytes(24).toString("base64url")}`;

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

export const nowIso = () => new Date().toISOString();
