import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openControlDb, type ControlDb } from "./open-control-db.js";
import { SqliteIdentityRepository } from "./identity-repository.js";
import { PlatformOperatorRepository } from "./platform-operator-repository.js";
import { KEY_OVERLAP_MS, TenantRegistrationRepository } from "./tenant-registration-repository.js";

const jwk = (x: string) => ({ kty: "OKP", crv: "Ed25519", x });
const sealed = { wrappedKey: "w", ciphertext: "c" };

describe("tenant registration and operator repositories", () => {
  const dirs: string[] = [];
  const closers: Array<() => void> = [];
  afterEach(() => {
    for (const close of closers.splice(0)) close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup(now = new Date("2026-10-08T12:00:00.000Z")) {
    const dir = mkdtempSync(join(tmpdir(), "registration-"));
    dirs.push(dir);
    const control: ControlDb = openControlDb(join(dir, "control.db"));
    closers.push(() => control.close());
    const identity = new SqliteIdentityRepository(control).createWithLogin({ kind: "google", subject: "s1" });
    const clock = { now };
    const repo = new TenantRegistrationRepository(control, () => clock.now);
    return { control, repo, clock, identityId: identity.id };
  }

  const input = (identityId: string, slug = "acme") => ({
    tenantSlug: slug,
    displayName: slug,
    origin: "https://acme.example",
    deploymentKeyId: `d-${slug}`,
    deploymentPublicKeyJwk: jwk("d"),
    oneonKeyId: `o-${slug}`,
    oneonPublicKeyJwk: jwk("o"),
    oneonPrivateKeySealed: sealed,
    enrolledBy: identityId,
  });

  it("creates the registration, both keys and an event together", () => {
    const { control, repo, identityId } = setup();
    const reg = repo.create(input(identityId));

    expect(reg).toMatchObject({ tenantId: reg.id, fileName: `${reg.id}.db`, status: "active", tenantSlug: "acme" });
    expect(repo.findById(reg.id)).toEqual(reg);
    expect(repo.findByIssuer("impressorx:acme")).toEqual(reg);
    expect(repo.findByIssuer("oneon")).toBeNull();
    expect(repo.listActive()).toEqual([reg]);
    expect(control.prepare("SELECT event FROM tenant_registration_events").all()).toEqual([{ event: "enrolled" }]);
    expect(control.prepare("SELECT owner, private_key_wrapped FROM tenant_keys ORDER BY owner").all()).toEqual([
      { owner: "deployment", private_key_wrapped: null },
      { owner: "oneon", private_key_wrapped: "w" },
    ]);
  });

  it("writes nothing when any part fails", () => {
    const { control, repo, identityId } = setup();
    repo.create(input(identityId));
    // Same slug: the registration insert fails.
    expect(() => repo.create(input(identityId))).toThrow();
    // Same key id under a new slug: the key insert fails after the registration insert.
    expect(() => repo.create({ ...input(identityId, "other"), oneonKeyId: "o-acme" })).toThrow();
    expect(control.prepare("SELECT COUNT(*) AS n FROM tenant_registrations").get()).toEqual({ n: 1 });
    expect(control.prepare("SELECT COUNT(*) AS n FROM tenant_registration_events").get()).toEqual({ n: 1 });
  });

  it("setStatus records an event and listActive drops the registration", () => {
    const { control, repo, identityId } = setup();
    const reg = repo.create(input(identityId));
    repo.setStatus(reg.id, "suspended_by_operator", identityId, "test");
    expect(repo.findById(reg.id)!.status).toBe("suspended_by_operator");
    expect(repo.listActive()).toEqual([]);
    expect(control.prepare("SELECT event FROM tenant_registration_events ORDER BY created_at, rowid").all()).toEqual([
      { event: "enrolled" },
      { event: "status_changed" },
    ]);
  });

  it("a pending Oneon key becomes current; retiring the others gives them seven days", () => {
    const { control, repo, clock, identityId } = setup();
    const reg = repo.create(input(identityId));
    clock.now = new Date(clock.now.getTime() + 1000);
    repo.addPendingOneonKey(reg.id, "o2", jwk("o2"), { wrappedKey: "w2", ciphertext: "c2" });

    expect(repo.currentOneonKey(reg.id)).toMatchObject({ keyId: "o2", sealedPrivateKey: { wrappedKey: "w2" } });
    expect(repo.unretiredOneonKeyIds(reg.id)).toEqual(["o2", "o-acme"]);

    repo.retireOtherOneonKeys(reg.id, "o2");
    expect(repo.unretiredOneonKeyIds(reg.id)).toEqual(["o2"]);
    const old = control.prepare("SELECT retired_at FROM tenant_keys WHERE key_id = 'o-acme'").get() as { retired_at: string };
    expect(Date.parse(old.retired_at) - Date.parse("2026-10-08T12:00:01.000Z")).toBe(KEY_OVERLAP_MS);
  });

  it("deleteOneonKey removes only an unretired Oneon key", () => {
    const { repo, identityId } = setup();
    const reg = repo.create(input(identityId));
    repo.addPendingOneonKey(reg.id, "o2", jwk("o2"), { wrappedKey: "w2", ciphertext: "c2" });
    repo.deleteOneonKey(reg.id, "o2");
    expect(repo.unretiredOneonKeyIds(reg.id)).toEqual(["o-acme"]);
  });

  it("create runs the in-transaction hook, and a throwing hook rolls everything back", () => {
    const { control, repo, identityId } = setup();
    let seen = "";
    const reg = repo.create(input(identityId), (r) => {
      seen = r.id;
      expect(repo.findById(r.id)).not.toBeNull(); // visible inside the transaction
    });
    expect(seen).toBe(reg.id);

    expect(() =>
      repo.create(input(identityId, "other"), () => {
        throw new Error("file failed");
      }),
    ).toThrow("file failed");
    expect(repo.findBySlug("other")).toBeNull();
    expect(control.prepare("SELECT COUNT(*) AS n FROM tenant_registrations").get()).toEqual({ n: 1 });
    expect(control.prepare("SELECT COUNT(*) AS n FROM tenant_keys").get()).toEqual({ n: 2 });
    expect(control.prepare("SELECT COUNT(*) AS n FROM tenant_registration_events").get()).toEqual({ n: 1 });
  });

  it("deploymentKeys returns unretired and still-retiring keys only", () => {
    const { repo, clock, identityId } = setup();
    const reg = repo.create(input(identityId));
    repo.addDeploymentKey(reg.id, "d-retiring", jwk("r"), new Date(clock.now.getTime() + 5000).toISOString());
    repo.addDeploymentKey(reg.id, "d-gone", jwk("g"), new Date(clock.now.getTime() - 5000).toISOString());
    expect(repo.deploymentKeys(reg.id).map((k) => k.keyId).sort()).toEqual(["d-acme", "d-retiring"]);
  });

  it("replaceDeploymentKeys retires keys the deployment no longer lists", () => {
    const { repo, identityId } = setup();
    const reg = repo.create(input(identityId));
    repo.replaceDeploymentKeys(reg.id, [{ keyId: "d-new", publicKeyJwk: jwk("n"), retiresAt: null }]);
    expect(repo.deploymentKeys(reg.id).map((k) => k.keyId)).toEqual(["d-new"]);
  });

  it("the latest operator row per identity decides", () => {
    const { control, identityId } = setup();
    const operators = new PlatformOperatorRepository(control);
    expect(operators.isOperator(identityId)).toBe(false);
    operators.grant(identityId);
    expect(operators.isOperator(identityId)).toBe(true);
    operators.remove(identityId);
    expect(operators.isOperator(identityId)).toBe(false);
    operators.grant(identityId);
    expect(operators.isOperator(identityId)).toBe(true);
  });
});
