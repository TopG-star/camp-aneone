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

  it("peek checks an intent exactly as consume does, without spending it", () => {
    const { intents, identity, advance } = setup();
    const { id, secret } = intents.create(identity.id);

    expect(intents.peek(id, secret)).toBe(identity.id);
    expect(intents.peek(id, secret)).toBe(identity.id);
    expect(intents.peek(id, "x".repeat(43))).toBeNull();
    expect(intents.peek("unknown-id", secret)).toBeNull();
    expect(intents.consume(id, secret)).toBe(identity.id);
    expect(intents.peek(id, secret)).toBeNull();

    const stale = intents.create(identity.id);
    advance(5 * 60 * 1000);
    expect(intents.peek(stale.id, stale.secret)).toBeNull();
  });

  it("is single-use across connections: a second connection cannot spend what the first spent", () => {
    const { path, intents, identity, advance } = setup();
    const second = openControlDb(path);
    dbs.push(second);
    const other = new LinkIntentRepository(second, () => new Date(Date.parse("2026-10-08T10:00:00.000Z") + 1000));
    const { id, secret } = intents.create(identity.id);
    advance(1000);

    expect([intents.consume(id, secret), other.consume(id, secret)].filter((r) => r !== null)).toEqual([identity.id]);
  });

  // A real race: the other consumer runs after this one has validated and before it writes. A consume that checks first
  // and writes after (SELECT, then UPDATE) lets both win; one conditional UPDATE cannot.
  it("is single-use when another consumer slips in between this one's check and its write", () => {
    const { path, intents, identity, advance } = setup();
    const second = openControlDb(path);
    dbs.push(second);
    const rival = new LinkIntentRepository(second, () => new Date(Date.parse("2026-10-08T10:00:00.000Z") + 1000));
    const { id, secret } = intents.create(identity.id);
    advance(1000);

    let rivalResult: string | null | undefined;
    const racing = new Proxy(dbs[0]!, {
      get(target, prop) {
        if (prop !== "prepare") return Reflect.get(target, prop, target);
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!/^s*UPDATE/i.test(sql)) return statement;
          return new Proxy(statement, {
            get(st, method) {
              const member = Reflect.get(st, method, st);
              if (method !== "run" && method !== "get" && method !== "all") return typeof member === "function" ? member.bind(st) : member;
              return (...args: unknown[]) => {
                // The write is about to happen: the rival gets in first, once.
                if (rivalResult === undefined) rivalResult = rival.consume(id, secret);
                return (member as (...a: unknown[]) => unknown).apply(st, args);
              };
            },
          });
        };
      },
    });
    const first = new LinkIntentRepository(racing as ControlDb, () => new Date(Date.parse("2026-10-08T10:00:00.000Z") + 1000)).consume(id, secret);

    expect(rivalResult).toBe(identity.id);
    expect(first).toBeNull();
  });
});
