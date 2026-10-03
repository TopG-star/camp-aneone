import { createHmac, hkdfSync } from "node:crypto";
import type { ModelContext } from "./types.js";

/** Keyed fingerprints (spec §8). A plain hash of small structured data could be reversed by guessing. */
export class Fingerprinter {
  constructor(private readonly masterKey: string, readonly keyVersion: number) {
    if (masterKey.length < 32) throw new Error("MODEL_AUDIT_HMAC_KEY must be at least 32 characters");
  }

  private keyFor(ctx: ModelContext): Buffer {
    const info = ctx.kind === "tenant" ? `tenant:${ctx.tenantId}` : `personal:${ctx.identityId}`;
    return Buffer.from(hkdfSync("sha256", this.masterKey, "oneon-model-audit", info, 32));
  }

  of(ctx: ModelContext, text: string): string {
    return createHmac("sha256", this.keyFor(ctx)).update(text).digest("hex");
  }

  policy(ctx: ModelContext, snapshot: unknown): string {
    return this.of(ctx, JSON.stringify(snapshot));
  }
}
