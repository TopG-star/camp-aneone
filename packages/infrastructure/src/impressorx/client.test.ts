import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@oneon/domain";
import { openControlDb, type ControlDb } from "../database/control/open-control-db.js";
import { SqliteIdentityRepository } from "../database/control/identity-repository.js";
import { TenantRegistrationRepository } from "../database/control/tenant-registration-repository.js";
import { GrantStore } from "../database/control/grant-store.js";
import { EnrolmentService } from "./enrolment-service.js";
import { FakeImpressorx } from "./fake-impressorx.js";
import { ImpressoRxClient, ImpressoRxRefusedError, ImpressoRxUnreachableError, type MembershipSnapshot } from "./client.js";
import { generateEd25519Key } from "../crypto/jws.js";
import { openSecret, sealSecret } from "../crypto/envelope.js";

const ORIGIN = "https://acme.example";
const CODE = "ABCD-EFGH-JKLM";

describe("ImpressoRx client against the fake deployment", () => {
  const dirs: string[] = [];
  const closers: Array<() => void> = [];
  afterEach(() => {
    for (const close of closers.splice(0)) close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function setup() {
    const dir = mkdtempSync(join(tmpdir(), "irx-client-"));
    dirs.push(dir);
    const control: ControlDb = openControlDb(join(dir, "control.db"));
    closers.push(() => control.close());
    const identityId = new SqliteIdentityRepository(control).createWithLogin({ kind: "google", subject: "s1" }).id;
    const repo = new TenantRegistrationRepository(control);

    let now = Date.now();
    const clock = () => new Date(now);
    const advance = (ms: number) => {
      now += ms;
    };
    const fake = new FakeImpressorx(ORIGIN, "acme", CODE, clock);
    const enrolmentKey = randomBytes(32).toString("base64");
    const grantKey = randomBytes(32).toString("base64");
    const enrolment = new EnrolmentService({
      repo,
      oneonOrigin: "https://oneon.example",
      masterKeyB64: enrolmentKey,
      fetchImpl: fake.fetch,
      clock,
    });
    const registration = await enrolment.enrol({ origin: ORIGIN, tenantSlug: "acme", enrolmentCode: CODE, enrolledBy: identityId });

    const membershipId = randomUUID();
    control
      .prepare(
        `INSERT INTO memberships (id, identity_id, tenant_registration_id, external_user_id, role, permissions_json,
           location_ids_json, status, snapshot_at, created_at) VALUES (?, ?, ?, 'staff-1', 'manager', '[]', '[]', 'active', ?, ?)`,
      )
      .run(membershipId, identityId, registration.id, clock().toISOString(), clock().toISOString());

    const grants = new GrantStore(control, grantKey, clock);
    const snapshots: Array<{ membershipId: string; snapshot: MembershipSnapshot }> = [];
    const logged: string[] = [];
    const logger: Logger = {
      info: (m, meta) => logged.push(JSON.stringify({ m, meta })),
      warn: (m, meta) => logged.push(JSON.stringify({ m, meta })),
      error: (m, meta) => logged.push(JSON.stringify({ m, meta })),
      debug: (m, meta) => logged.push(JSON.stringify({ m, meta })),
    };
    const client = new ImpressoRxClient({
      registrations: repo,
      grants,
      enrolment,
      onSnapshot: (id, snapshot) => snapshots.push({ membershipId: id, snapshot }),
      fetchImpl: fake.fetch,
      clock,
      logger,
      sleep: async () => undefined,
    });

    const storedValue = (id: string) => {
      const row = control.prepare("SELECT encrypted_value, wrapped_key FROM delegation_grants WHERE id = ?").get(id) as { encrypted_value: string; wrapped_key: string };
      return openSecret({ ciphertext: row.encrypted_value, wrappedKey: row.wrapped_key }, grantKey);
    };
    const launch = async (sessionId = randomUUID(), staffUserId = "staff-1") => {
      const handoff = await fake.mintHandoff(staffUserId);
      const { grantId } = await client.exchangeHandoff(registration.id, handoff, sessionId, identityId, membershipId);
      return { grantId, sessionId, handoff };
    };
    return { enrolmentKey, storedValue, control, repo, fake, enrolment, registration, grants, client, launch, advance, snapshots, logged, identityId, membershipId };
  }

  const expireTokens = (s: { advance: (ms: number) => void }) => s.advance(5 * 60 * 1000);

  it("exchanges a hand-off and stores the grant sealed", async () => {
    const s = await setup();
    const { grantId } = await s.launch();
    const value = s.fake.grantValue(grantId)!;
    const row = s.control.prepare("SELECT * FROM delegation_grants WHERE id = ?").get(grantId) as Record<string, unknown>;
    expect(row.kind).toBe("attended");
    expect(row.status).toBe("active");
    expect(JSON.stringify(row)).not.toContain(value);
    expect(s.snapshots).toHaveLength(1);
    expect(s.snapshots[0]!.membershipId).toBe(s.membershipId);
  });

  it("rotates and persists the new value on each exchange, and refreshes the snapshot", async () => {
    const s = await setup();
    const { grantId, sessionId } = await s.launch();
    const calls = s.client.forSession(sessionId)!;
    const first = await calls.accessToken();
    expect(await calls.accessToken()).toBe(first); // cached until 30 s before expiry
    expect(s.fake.rotations).toBe(0);

    expireTokens(s);
    await calls.accessToken();
    expireTokens(s);
    await calls.accessToken();
    expect(s.fake.rotations).toBe(2);
    expect(s.storedValue(grantId)).toBe(s.fake.grantValue(grantId));
    expect(s.fake.theftRevocations).toEqual([]);
    expect(s.snapshots).toHaveLength(3);
  });

  it("retries a crashed exchange with the same requestId and gets the same value", async () => {
    const s = await setup();
    const { grantId, sessionId } = await s.launch();
    const calls = s.client.forSession(sessionId)!;
    expireTokens(s);

    const complete = vi.spyOn(s.grants, "completeExchange").mockImplementationOnce(() => {
      throw new Error("crash after the fake responded");
    });
    await expect(calls.accessToken()).rejects.toThrow("crash");
    complete.mockRestore();

    await calls.accessToken();
    const grantRequests = s.fake.tokenRequests.filter((r) => r.grantType === "grant");
    expect(grantRequests.map((r) => r.outcome)).toEqual(["ok", "cached"]);
    expect(grantRequests[0]!.requestId).toBe(grantRequests[1]!.requestId);
    expect(grantRequests[0]!.jti).not.toBe(grantRequests[1]!.jti);
    expect(s.fake.rotations).toBe(1);
    expect(s.fake.theftRevocations).toEqual([]);
    expect(s.storedValue(grantId)).toBe(s.fake.grantValue(grantId));
    const row = s.control.prepare("SELECT pending_request_id FROM delegation_grants WHERE id = ?").get(grantId) as { pending_request_id: string | null };
    expect(row.pending_request_id).toBeNull();
  });

  it("ten concurrent accessToken() calls cause one exchange", async () => {
    const s = await setup();
    const { sessionId } = await s.launch();
    const calls = s.client.forSession(sessionId)!;
    expireTokens(s);
    const tokens = await Promise.all(Array.from({ length: 10 }, () => calls.accessToken()));
    expect(new Set(tokens).size).toBe(1);
    expect(s.fake.tokenRequests.filter((r) => r.grantType === "grant")).toHaveLength(1);
    expect(s.fake.theftRevocations).toEqual([]);
  });

  it("concurrent calls for different actions are serialised, never theft", async () => {
    const s = await setup();
    const { grantId } = await s.launch();
    const calls = s.client.forGrant(grantId);
    expireTokens(s);
    await Promise.all([calls.accessToken({ oneonActionId: "a1" }), calls.accessToken({ oneonActionId: "a2" }), calls.accessToken()]);
    expect(s.fake.rotations).toBe(3);
    expect(s.fake.theftRevocations).toEqual([]);
  });

  it("two sessions for the same person hold two grants and never trip theft detection", async () => {
    const s = await setup();
    const one = await s.launch();
    const two = await s.launch();
    expect(one.grantId).not.toBe(two.grantId);
    expireTokens(s);
    for (let i = 0; i < 3; i++) {
      await s.client.forSession(one.sessionId)!.accessToken();
      await s.client.forSession(two.sessionId)!.accessToken();
      expireTokens(s);
    }
    expect(s.fake.theftRevocations).toEqual([]);
    expect(s.storedValue(one.grantId)).toBe(s.fake.grantValue(one.grantId));
    expect(s.storedValue(two.grantId)).toBe(s.fake.grantValue(two.grantId));
  });

  it("maps 401 to ImpressoRxRefusedError and network failure, 503 and timeouts to ImpressoRxUnreachableError", async () => {
    const s = await setup();
    const { grantId, sessionId } = await s.launch();
    const calls = s.client.forSession(sessionId)!;
    expireTokens(s);

    s.fake.networkFailure = true;
    await expect(calls.accessToken()).rejects.toBeInstanceOf(ImpressoRxUnreachableError);
    s.fake.networkFailure = false;
    s.fake.unavailable = true;
    await expect(calls.accessToken()).rejects.toBeInstanceOf(ImpressoRxUnreachableError);
    s.fake.unavailable = false;

    // Infrastructure failures never revoke: the next call reuses the stored request id and succeeds.
    await calls.accessToken();
    expect(s.fake.theftRevocations).toEqual([]);

    s.fake.grants.get(grantId)!.status = "revoked";
    expireTokens(s);
    await expect(calls.accessToken()).rejects.toBeInstanceOf(ImpressoRxRefusedError);
  });

  it("does not retry a hand-off exchange after an ambiguous failure", async () => {
    const s = await setup();
    s.fake.loseNextTokenResponse = true;
    const handoff = await s.fake.mintHandoff("staff-1");
    await expect(s.client.exchangeHandoff(s.registration.id, handoff, "sess", s.identityId, s.membershipId)).rejects.toBeInstanceOf(
      ImpressoRxUnreachableError,
    );
    expect(s.fake.tokenRequests.filter((r) => r.grantType === "handoff")).toHaveLength(1);
    expect(s.control.prepare("SELECT COUNT(*) AS n FROM delegation_grants").get()).toEqual({ n: 0 });
  });

  it("retries a lost response with a fresh JWS, the same requestId and the same value", async () => {
    const s = await setup();
    const { sessionId } = await s.launch();
    const calls = s.client.forSession(sessionId)!;
    expireTokens(s);
    s.fake.loseNextTokenResponse = true;
    await calls.accessToken();
    const grantRequests = s.fake.tokenRequests.filter((r) => r.grantType === "grant");
    expect(grantRequests.map((r) => r.outcome)).toEqual(["ok", "cached"]);
    expect(grantRequests[0]!.requestId).toBe(grantRequests[1]!.requestId);
    expect(grantRequests[0]!.jti).not.toBe(grantRequests[1]!.jti);
    expect(s.fake.rotations).toBe(1);
    expect(s.fake.theftRevocations).toEqual([]);
  });

  it("falls back to an older signing key on 401, with the same requestId and a fresh jti", async () => {
    const s = await setup();
    const { sessionId } = await s.launch();
    // A newest key the deployment never received (an unclear rotation).
    const lost = await generateEd25519Key();
    s.repo.addPendingOneonKey(s.registration.id, lost.keyId, lost.publicKeyJwk, sealSecret(JSON.stringify(lost.privateKeyJwk), s.enrolmentKey));
    expireTokens(s);
    await s.client.forSession(sessionId)!.accessToken();
    const requests = s.fake.tokenRequests.filter((r) => r.grantType === "grant");
    expect(requests).toHaveLength(1); // the unknown-key attempt was refused before it counted
    expect(requests[0]!.kid).not.toBe(lost.keyId);
    expect(s.fake.rotations).toBe(1);
  });

  it("issues an unattended grant and stores it with its action id", async () => {
    const s = await setup();
    const { grantId, sessionId } = await s.launch();
    const calls = s.client.forSession(sessionId)!;
    expireTokens(s);
    const expires = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const issued = await calls.issue({ kind: "action", oneonActionId: "act-1", scope: ["jobs.read"], absoluteExpiresAt: expires });

    const row = s.control.prepare("SELECT * FROM delegation_grants WHERE id = ?").get(issued.grantId) as Record<string, unknown>;
    expect(row).toMatchObject({ kind: "action", action_id: "act-1", status: "active", absolute_expires_at: expires, identity_id: s.identityId });
    expect(row.session_id).toBeNull();
    expect(JSON.stringify(row)).not.toContain(s.fake.grantValue(issued.grantId)!);
    expect(s.grants.findActionGrant("act-1")).toBe(issued.grantId);
    // The attended grant rotated too, and the issued one can mint a token.
    expect(s.storedValue(grantId)).toBe(s.fake.grantValue(grantId));
    expect(await s.client.forGrant(issued.grantId).accessToken({ oneonActionId: "act-1" })).toEqual(expect.any(String));
    expect(s.fake.theftRevocations).toEqual([]);
  });

  it("me() returns and applies the snapshot; a 401 is a refusal and a 503 is unreachable", async () => {
    const s = await setup();
    const { sessionId } = await s.launch();
    s.fake.snapshots.set("staff-1", { userId: "staff-1", role: "owner", permissions: ["a"], locationIds: ["l"], tokenVersion: 4, tenantStatus: "active" });
    const calls = s.client.forSession(sessionId)!;
    const before = s.snapshots.length;
    expect(await calls.me()).toMatchObject({ role: "owner", tokenVersion: 4 });
    expect(s.snapshots.length).toBe(before + 1);
    s.fake.unavailable = true;
    await expect(calls.me()).rejects.toBeInstanceOf(ImpressoRxUnreachableError);
  });

  it("a tRPC refusal refuses the call but never revokes the grant", async () => {
    const s = await setup();
    const { grantId, sessionId } = await s.launch();
    await expect(s.client.forSession(sessionId)!.trpc("customer.list", { a: 1 }, "query")).rejects.toMatchObject({
      name: "ImpressoRxRefusedError",
      status: 403,
    });
    expect(s.grants.find(grantId)!.status).toBe("active");
    s.fake.unavailable = true;
    await expect(s.client.forSession(sessionId)!.trpc("customer.update", {}, "mutation")).rejects.toBeInstanceOf(ImpressoRxUnreachableError);
  });

  it("revoke() marks the grant revoked locally and at the deployment", async () => {
    const s = await setup();
    const { grantId, sessionId } = await s.launch();
    await s.client.forSession(sessionId)!.revoke();
    expect(s.grants.find(grantId)!.status).toBe("revoked");
    expect(s.fake.grants.get(grantId)!.status).toBe("revoked");
    expect(s.client.forSession(sessionId)).toBeNull();
    await expect(s.client.forGrant(grantId).accessToken()).rejects.toBeInstanceOf(ImpressoRxRefusedError);
  });

  it("never logs grant values or tokens", async () => {
    const s = await setup();
    const { grantId, sessionId } = await s.launch();
    const calls = s.client.forSession(sessionId)!;
    const secrets = new Set<string>();
    const remember = () => {
      secrets.add(s.fake.grantValue(grantId)!);
    };
    remember();
    secrets.add(await calls.accessToken());
    expireTokens(s);
    s.fake.unavailable = true;
    await calls.accessToken().catch(() => undefined);
    s.fake.unavailable = false;
    secrets.add(await calls.accessToken());
    remember();
    s.fake.grants.get(grantId)!.status = "revoked";
    expireTokens(s);
    await calls.accessToken().catch(() => undefined);

    expect(s.logged.length).toBeGreaterThan(0);
    for (const secret of secrets) for (const line of s.logged) expect(line).not.toContain(secret);
  });
});
