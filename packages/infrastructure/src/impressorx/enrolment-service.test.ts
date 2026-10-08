import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { openControlDb, type ControlDb } from "../database/control/open-control-db.js";
import { SqliteIdentityRepository } from "../database/control/identity-repository.js";
import { TenantRegistrationRepository } from "../database/control/tenant-registration-repository.js";
import { EnrolmentFailedError, EnrolmentService, SigningKeyNotConfiguredError, type FetchLike } from "./enrolment-service.js";
import { FakeImpressorx } from "./fake-impressorx.js";
import { generateEd25519Key, signJws } from "../crypto/jws.js";

const ORIGIN = "https://acme.example";
const CODE = "ABCD-EFGH-JKLM";

describe("enrolment service against the fake deployment", () => {
  const dirs: string[] = [];
  const closers: Array<() => void> = [];
  afterEach(() => {
    for (const close of closers.splice(0)) close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup(masterKey: string | null = randomBytes(32).toString("base64"), wrap?: (inner: FetchLike) => FetchLike) {
    const dir = mkdtempSync(join(tmpdir(), "enrol-"));
    dirs.push(dir);
    const control: ControlDb = openControlDb(join(dir, "control.db"));
    closers.push(() => control.close());
    const identityId = new SqliteIdentityRepository(control).createWithLogin({ kind: "google", subject: "s1" }).id;
    const repo = new TenantRegistrationRepository(control);
    const fake = new FakeImpressorx(ORIGIN, "acme", CODE);
    const calls: Array<{ url: string; body: unknown }> = [];
    const recording: FetchLike = (input, init) => {
      calls.push({ url: input.toString(), body: init?.body ? JSON.parse(String(init.body)) : null });
      return fake.fetch(input, init);
    };
    const fetchImpl = wrap ? wrap(recording) : recording;
    const service = new EnrolmentService({ repo, oneonOrigin: "https://oneon.example", masterKeyB64: masterKey ?? undefined, fetchImpl });
    const enrol = () => service.enrol({ origin: ORIGIN, tenantSlug: "acme", enrolmentCode: CODE, enrolledBy: identityId });
    return { control, repo, fake, service, enrol, identityId, calls };
  }

  const unrecordedToken = async (kid: string) => {
    const k = await generateEd25519Key();
    return signJws({ privateKeyJwk: k.privateKeyJwk, kid, iss: "impressorx:acme", aud: "oneon" });
  };

  it("enrols, stores both keys, and seals the private key", async () => {
    const { control, repo, enrol } = setup();
    const reg = await enrol();
    expect(reg).toMatchObject({ tenantSlug: "acme", displayName: "acme", origin: ORIGIN, status: "active" });
    expect(repo.deploymentKeys(reg.id)).toHaveLength(1);
    const row = control.prepare("SELECT private_key_ciphertext FROM tenant_keys WHERE owner = 'oneon'").get() as { private_key_ciphertext: string };
    expect(row.private_key_ciphertext).not.toContain('"d"');
  });

  it("sends every JWK as a JSON string and the fake refuses object JWKs", async () => {
    const { enrol, calls, repo, service } = setup();
    const reg = await enrol();
    const enrolClaims = decodeJwt((calls[0]!.body as { request: string }).request);
    expect(typeof enrolClaims.oneonPublicKeyJwk).toBe("string");
    expect(JSON.parse(enrolClaims.oneonPublicKeyJwk as string)).toMatchObject({ kty: "OKP", crv: "Ed25519" });

    await service.rotateOneonKey(reg.id);
    const rotateCall = calls.find((c) => c.url.endsWith("/api/oneon/keys") && c.body)!;
    expect(typeof decodeJwt((rotateCall.body as { request: string }).request).newPublicKeyJwk).toBe("string");
    expect(repo.deploymentKeys(reg.id)).toHaveLength(1);
  });

  it("refuses a reply that carries the deployment JWK as an object", async () => {
    const { control, fake, enrol } = setup();
    fake.replyJwkAsObject = true;
    await expect(enrol()).rejects.toBeInstanceOf(EnrolmentFailedError);
    expect(control.prepare("SELECT COUNT(*) AS n FROM tenant_registrations").get()).toEqual({ n: 0 });
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
    await expect(service.enrol({ origin: ORIGIN, tenantSlug: "acme", enrolmentCode: "WRONG", enrolledBy: identityId })).rejects.toBeInstanceOf(
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
    expect(repo.unretiredOneonKeyIds(reg.id)).toEqual([second]);

    await service.rotateOneonKey(reg.id);
    expect(fake.acceptedOneonKeyIds).toEqual([first, second]);
    expect((await service.oneonSigningKey(reg.id)).keyId).toBe(repo.currentOneonKey(reg.id)!.keyId);
  });

  it("rotateOneonKey stores nothing new when the deployment refuses", async () => {
    const { control, repo, fake, service, enrol } = setup();
    const reg = await enrol();
    const before = repo.currentOneonKey(reg.id)!.keyId;
    fake.refuseKeyAdds = true;
    await expect(service.rotateOneonKey(reg.id)).rejects.toBeInstanceOf(EnrolmentFailedError);
    expect(repo.currentOneonKey(reg.id)!.keyId).toBe(before);
    expect(control.prepare("SELECT COUNT(*) AS n FROM tenant_keys WHERE owner = 'oneon'").get()).toEqual({ n: 1 });
  });

  it("rotateOneonKey recovers when the change landed at the deployment but the answer was lost", async () => {
    let lose = false;
    const { repo, fake, service, enrol } = setup(undefined, (inner) => async (input, init) => {
      const res = await inner(input, init);
      if (lose && res.status === 204 && init?.method === "POST" && input.toString().endsWith("/api/oneon/keys")) throw new Error("connection reset");
      return res;
    });
    const reg = await enrol();
    const k1 = repo.currentOneonKey(reg.id)!.keyId;

    lose = true;
    await expect(service.rotateOneonKey(reg.id)).rejects.toBeInstanceOf(EnrolmentFailedError);
    const k2 = fake.oneonKeys[1]!.keyId; // the deployment applied it
    expect(repo.unretiredOneonKeyIds(reg.id)).toContain(k2); // and Oneon kept it
    expect(repo.unretiredOneonKeyIds(reg.id)).toContain(k1);

    // The deployment now refuses k1 (retiring); the next rotation still works by falling back to k2.
    lose = false;
    await service.rotateOneonKey(reg.id);
    expect(fake.acceptedOneonKeyIds).toEqual([k1, k2]); // k1 landed the lost change; k2 signs this one
    const k3 = repo.currentOneonKey(reg.id)!.keyId;
    expect(repo.unretiredOneonKeyIds(reg.id)).toEqual([k3]);
  });

  const isKeyAdd = (input: string | URL, init?: RequestInit) => init?.method === "POST" && input.toString().endsWith("/api/oneon/keys");

  it("two rotations that never landed do not lock rotation: the original key eventually signs", async () => {
    let mode: "down" | "up" = "up";
    const { repo, fake, service, enrol, calls } = setup(undefined, (inner) => async (input, init) => {
      if (mode === "down" && isKeyAdd(input, init)) return new Response(null, { status: 503 });
      return inner(input, init);
    });
    const reg = await enrol();
    const k1 = repo.currentOneonKey(reg.id)!.keyId;

    mode = "down";
    await expect(service.rotateOneonKey(reg.id)).rejects.toBeInstanceOf(EnrolmentFailedError);
    await expect(service.rotateOneonKey(reg.id)).rejects.toBeInstanceOf(EnrolmentFailedError);
    expect(repo.unretiredOneonKeyIds(reg.id)).toHaveLength(3);

    mode = "up";
    await service.rotateOneonKey(reg.id);
    expect(fake.acceptedOneonKeyIds).toEqual([k1]); // k1 is the only key the deployment holds
    const k4 = repo.currentOneonKey(reg.id)!.keyId;
    expect(repo.unretiredOneonKeyIds(reg.id)).toEqual([k4]);

    // The announced key never signed its own announcement.
    for (const call of calls.filter((c) => c.url.endsWith("/api/oneon/keys") && c.body)) {
      const token = (call.body as { request: string }).request;
      expect(decodeProtectedHeader(token).kid).not.toBe(decodeJwt(token).newKeyId);
    }
  });

  it("a 429 keeps the new key, a 401 deletes it", async () => {
    let status = 429;
    const { repo, service, enrol } = setup(undefined, (inner) => async (input, init) => {
      if (isKeyAdd(input, init) && status !== 0) return new Response(null, { status });
      return inner(input, init);
    });
    const reg = await enrol();
    await expect(service.rotateOneonKey(reg.id)).rejects.toBeInstanceOf(EnrolmentFailedError);
    expect(repo.unretiredOneonKeyIds(reg.id)).toHaveLength(2);

    status = 401;
    await expect(service.rotateOneonKey(reg.id)).rejects.toBeInstanceOf(EnrolmentFailedError);
    expect(repo.unretiredOneonKeyIds(reg.id)).toHaveLength(2); // the 401 key was removed again
  });

  it("refreshDeploymentKeys accepts a list signed by a known key", async () => {
    const { repo, service, enrol } = setup();
    const reg = await enrol();
    await service.refreshDeploymentKeys(reg.id);
    expect(repo.deploymentKeys(reg.id)).toHaveLength(1);
  });

  it("refreshDeploymentKeys learns a rotated key because the list is signed by the oldest valid key", async () => {
    const { repo, fake, service, enrol } = setup();
    const reg = await enrol();
    const newKey = await fake.rotateDeploymentKey();
    await service.refreshDeploymentKeys(reg.id);
    expect(repo.deploymentKeys(reg.id).map((k) => k.keyId)).toContain(newKey.keyId);
  });

  it("refreshDeploymentKeys refuses a list signed by an unknown key and changes nothing", async () => {
    const { repo, fake, service, enrol } = setup();
    const reg = await enrol();
    const known = repo.deploymentKeys(reg.id).map((k) => k.keyId);
    fake.signListWithUnknownKey = true;
    await expect(service.refreshDeploymentKeys(reg.id)).rejects.toBeInstanceOf(EnrolmentFailedError);
    expect(repo.deploymentKeys(reg.id).map((k) => k.keyId)).toEqual(known);
  });

  it("verifyFromDeployment does not touch the network for a bad signature under a known kid", async () => {
    const { repo, service, enrol, calls } = setup();
    const reg = await enrol();
    const knownKid = repo.deploymentKeys(reg.id)[0]!.keyId;
    const before = calls.length;
    await expect(service.verifyFromDeployment(reg.id, await unrecordedToken(knownKid), { audience: "oneon" })).rejects.toBeInstanceOf(
      EnrolmentFailedError,
    );
    expect(calls.length).toBe(before);
  });

  it("verifyFromDeployment refreshes for an unknown kid, at most once a minute, and always fails with EnrolmentFailedError", async () => {
    const { service, enrol, calls } = setup();
    const reg = await enrol();
    const before = calls.length;
    const token = await unrecordedToken("never-seen");

    await expect(service.verifyFromDeployment(reg.id, token, { audience: "oneon" })).rejects.toBeInstanceOf(EnrolmentFailedError);
    expect(calls.length).toBe(before + 1);
    await expect(service.verifyFromDeployment(reg.id, token, { audience: "oneon" })).rejects.toBeInstanceOf(EnrolmentFailedError);
    expect(calls.length).toBe(before + 1);
  });

  it("verifyFromDeployment accepts a message under a key learned by the refresh", async () => {
    const { fake, service, enrol } = setup();
    const reg = await enrol();
    const newKey = await fake.rotateDeploymentKey();
    const token = await signJws({ privateKeyJwk: newKey.privateKeyJwk, kid: newKey.keyId, iss: "impressorx:acme", aud: "oneon" });
    expect((await service.verifyFromDeployment(reg.id, token, { audience: "oneon" })).kid).toBe(newKey.keyId);
  });
});
