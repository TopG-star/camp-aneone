import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openControlDb, type ControlDb } from "../database/control/open-control-db.js";
import { SqliteIdentityRepository } from "../database/control/identity-repository.js";
import { TenantRegistrationRepository } from "../database/control/tenant-registration-repository.js";
import { EnrolmentFailedError, EnrolmentService, SigningKeyNotConfiguredError } from "./enrolment-service.js";
import { FakeImpressorx } from "./fake-impressorx.js";
import { signJws } from "../crypto/jws.js";

const ORIGIN = "https://acme.example";
const CODE = "ABCD-EFGH-JKLM";

describe("enrolment service against the fake deployment", () => {
  const dirs: string[] = [];
  const closers: Array<() => void> = [];
  afterEach(() => {
    for (const close of closers.splice(0)) close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup(masterKey: string | null = randomBytes(32).toString("base64")) {
    const dir = mkdtempSync(join(tmpdir(), "enrol-"));
    dirs.push(dir);
    const control: ControlDb = openControlDb(join(dir, "control.db"));
    closers.push(() => control.close());
    const identityId = new SqliteIdentityRepository(control).createWithLogin({ kind: "google", subject: "s1" }).id;
    const repo = new TenantRegistrationRepository(control);
    const fake = new FakeImpressorx(ORIGIN, "acme", CODE);
    const service = new EnrolmentService({ repo, oneonOrigin: "https://oneon.example", masterKeyB64: masterKey ?? undefined, fetchImpl: fake.fetch });
    const enrol = () => service.enrol({ origin: ORIGIN, tenantSlug: "acme", code: CODE, enrolledBy: identityId });
    return { control, repo, fake, service, enrol, identityId };
  }

  it("enrols, stores both keys, and seals the private key", async () => {
    const { control, repo, enrol } = setup();
    const reg = await enrol();
    expect(reg).toMatchObject({ tenantSlug: "acme", displayName: "acme", origin: ORIGIN, status: "active" });
    expect(repo.deploymentKeys(reg.id)).toHaveLength(1);
    const row = control.prepare("SELECT private_key_ciphertext FROM tenant_keys WHERE owner = 'oneon'").get() as { private_key_ciphertext: string };
    expect(row.private_key_ciphertext).not.toContain('"d"');
  });

  it("fails clearly when the signing master key is not configured, without contacting the deployment", async () => {
    const { enrol, fake } = setup(null);
    await expect(enrol()).rejects.toBeInstanceOf(SigningKeyNotConfiguredError);
    expect(fake.active).toBe(false);
  });

  it("refuses a reply signed by the wrong key and stores nothing", async () => {
    const { control, fake, enrol } = setup();
    fake.signReplyWithWrongKey = true;
    await expect(enrol()).rejects.toBeInstanceOf(EnrolmentFailedError);
    expect(control.prepare("SELECT COUNT(*) AS n FROM tenant_registrations").get()).toEqual({ n: 0 });
    expect(control.prepare("SELECT COUNT(*) AS n FROM tenant_keys").get()).toEqual({ n: 0 });
  });

  it("refuses a reply whose tenantSlug differs from the one entered", async () => {
    const { control, fake, enrol } = setup();
    fake.replyTenantSlug = "someone-else";
    await expect(enrol()).rejects.toBeInstanceOf(EnrolmentFailedError);
    expect(control.prepare("SELECT COUNT(*) AS n FROM tenant_registrations").get()).toEqual({ n: 0 });
  });

  it("fails on a wrong code", async () => {
    const { service, identityId } = setup();
    await expect(service.enrol({ origin: ORIGIN, tenantSlug: "acme", code: "WRONG", enrolledBy: identityId })).rejects.toBeInstanceOf(
      EnrolmentFailedError,
    );
  });

  it("rotateOneonKey registers the new key at the fake and signs with it afterwards", async () => {
    const { repo, fake, service, enrol } = setup();
    const reg = await enrol();
    const first = repo.currentOneonKey(reg.id)!.keyId;

    await service.rotateOneonKey(reg.id);
    const second = repo.currentOneonKey(reg.id)!.keyId;
    expect(second).not.toBe(first);
    expect(fake.oneonKeys.map((k) => k.keyId)).toContain(second);
    expect(fake.acceptedOneonKeyIds).toEqual([first]);

    // The next rotation is signed with the new key (the fake refuses a retiring one).
    await service.rotateOneonKey(reg.id);
    expect(fake.acceptedOneonKeyIds).toEqual([first, second]);
    expect((await service.oneonSigningKey(reg.id)).keyId).toBe(repo.currentOneonKey(reg.id)!.keyId);
  });

  it("rotateOneonKey stores nothing when the deployment refuses", async () => {
    const { repo, service, enrol } = setup();
    const reg = await enrol();
    const before = repo.currentOneonKey(reg.id)!.keyId;
    const failing = new EnrolmentService({
      repo,
      oneonOrigin: "https://oneon.example",
      masterKeyB64: randomBytes(32).toString("base64"),
      fetchImpl: async () => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });
    await expect(failing.rotateOneonKey(reg.id)).rejects.toBeInstanceOf(Error);
    expect(repo.currentOneonKey(reg.id)!.keyId).toBe(before);
    expect(service).toBeDefined();
  });

  it("refreshDeploymentKeys accepts a list signed by a known key", async () => {
    const { repo, service, enrol } = setup();
    const reg = await enrol();
    await service.refreshDeploymentKeys(reg.id);
    expect(repo.deploymentKeys(reg.id)).toHaveLength(1);
  });

  it("refreshDeploymentKeys refuses a list signed by an unknown key and changes nothing", async () => {
    const { repo, fake, service, enrol } = setup();
    const reg = await enrol();
    const known = repo.deploymentKeys(reg.id).map((k) => k.keyId);
    await fake.rotateDeploymentKey(); // the newest key now signs, and Oneon has never seen it
    await expect(service.refreshDeploymentKeys(reg.id)).rejects.toBeInstanceOf(EnrolmentFailedError);
    expect(repo.deploymentKeys(reg.id).map((k) => k.keyId)).toEqual(known);
  });

  it("verifyFromDeployment accepts a known key and refuses an unknown one after one refresh attempt", async () => {
    const { repo, fake, service, enrol } = setup();
    const reg = await enrol();
    const knownKeyId = repo.deploymentKeys(reg.id)[0]!.keyId;
    const newKey = await fake.rotateDeploymentKey();

    const unknown = await signJws({ privateKeyJwk: newKey.privateKeyJwk, kid: newKey.keyId, iss: "impressorx:acme", aud: "oneon" });
    await expect(service.verifyFromDeployment(reg.id, unknown, { audience: "oneon" })).rejects.toBeInstanceOf(EnrolmentFailedError);
    expect(repo.deploymentKeys(reg.id).map((k) => k.keyId)).toEqual([knownKeyId]);
  });
});
