// Secrets at rest (provider API keys, enrollment tokens): AES-256-GCM with a master key
// from ALLIANCE_MASTER_KEY or a key file generated in the data directory on first boot.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class Secrets {
  private key: Buffer;

  constructor(dataDir: string, masterKey?: string) {
    if (masterKey) {
      const k = /^[0-9a-f]{64}$/i.test(masterKey) ? Buffer.from(masterKey, "hex") : Buffer.from(masterKey, "base64");
      if (k.length !== 32) throw new Error("ALLIANCE_MASTER_KEY must be 32 bytes (64 hex chars or base64)");
      this.key = k;
      return;
    }
    const file = join(dataDir, "master.key");
    if (!existsSync(file)) {
      writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
      try {
        chmodSync(file, 0o600);
      } catch {
        /* best effort on Windows */
      }
    }
    this.key = Buffer.from(readFileSync(file, "utf8").trim(), "hex");
    if (this.key.length !== 32) throw new Error(`${file} is corrupt`);
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
  }

  decrypt(blob: string): string {
    const [v, iv, tag, ct] = blob.split(":");
    if (v !== "v1" || !iv || !tag || !ct) throw new Error("unknown secret format");
    const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
    d.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
  }
}
