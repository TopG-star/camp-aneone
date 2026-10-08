import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openControlDb, type ControlDb } from "./open-control-db.js";
import { SqliteIdentityRepository } from "./identity-repository.js";
import { LinkIntentRepository } from "./link-intent-repository.js";

describe("link intents", () => {
  const dirs: string[] = [];
  const dbs: ControlDb[] = [];
  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "link-intent-"));
    dirs.push(dir);
    const path = join(dir, "control.db");
    const control = openControlDb(path);
    dbs.push(control);
    let now = Date.parse("2026-10-08T10:00:00.000Z");
    const intents = new LinkIntentRepository(control, () => new Date(now));
    const identity = new SqliteIdentityRepository(control).createWithLogin({ kind: "google", subject: "g1" });
    return { path, control, intents, identity, advance: (ms: number) => (now += ms) };
  }

  it("returns a random secret of at least 32 bytes and stores only its hash", () => {
    const { control, intents, identity } = setup();
    const a = intents.create(identity.id);
    const b = intents.create(identity.id);

    expect(Buffer.from(a.secret, "base64url").length).toBeGreaterThanOrEqual(32);
    expect(a.secret).not.toBe(b.secret);
    const row = control.prepare("SELECT * FROM link_intents WHERE id = ?").get(a.id) as Record<string, unknown>;
    expect(row.binding_hash).toBe(createHash("sha256").update(a.secret).digest("hex"));
    expect(row.identity_id).toBe(identity.id);
    expect(row.used_at).toBeNull();
    expect(Date.parse(row.expires_at as string) - Date.parse("2026-10-08T10:00:00.000Z")).toBe(5 * 60 * 1000);
    expect(JSON.stringify(control.prepare("SELECT * FROM link_intents").all())).not.toContain(a.secret);
  });

  it("consumes once with the right secret and names the identity that created it", () => {
    const { intents, identity } = setup();
    const { id, secret } = intents.create(identity.id);

    expect(intents.consume(id, secret)).toBe(identity.id);
    expect(intents.consume(id, secret)).toBeNull();
  });

  it("refuses a wrong or missing secret without using the intent up", () => {
    const { intents, identity } = setup();
    const { id, secret } = intents.create(identity.id);

    expect(intents.consume(id, "x".repeat(43))).toBeNull();
    expect(intents.consume(id, "")).toBeNull();
    expect(intents.consume("unknown-id", secret)).toBeNull();
    expect(intents.consume(id, secret)).toBe(identity.id);
  });

  it("refuses an intent after 5 minutes", () => {
    const { intents, identity, advance } = setup();
    const fresh = intents.create(identity.id);
    advance(4 * 60 * 1000 + 59_000);
    expect(intents.consume(fresh.id, fresh.secret)).toBe(identity.id);

    const stale = intents.create(identity.id);
    advance(5 * 60 * 1000);
    expect(intents.consume(stale.id, stale.secret)).toBeNull();
  });

  it("is single-use across connections: of two concurrent consumers exactly one wins", () => {
    const { path, intents, identity, advance } = setup();
    const second = openControlDb(path);
    dbs.push(second);
    const other = new LinkIntentRepository(second, () => new Date(Date.parse("2026-10-08T10:00:00.000Z") + 1000));
    const { id, secret } = intents.create(identity.id);
    advance(1000);

    const results = [intents.consume(id, secret), other.consume(id, secret)];

    expect(results.filter((r) => r !== null)).toEqual([identity.id]);
  });
});
