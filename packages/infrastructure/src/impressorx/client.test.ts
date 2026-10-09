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
import { EnrolmentService, type FetchLike } from "./enrolment-service.js";
import { FakeImpressorx } from "./fake-impressorx.js";
import {
  createImpressoRxClient,
  ImpressoRxClient,
  ImpressoRxRefusedError,
  ImpressoRxUnauthorizedError,
  ImpressoRxUnreachableError,
  type MembershipSnapshot,
} from "./client.js";
import { generateEd25519Key } from "../crypto/jws.js";
import { openSecret, sealSecret } from "../crypto/envelope.js";
import { decodeJwt } from "jose";

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
    // Applies the request at the fake, then loses the reply (on token calls) while `dropReplies` is set. `afterToken` runs after each
    // token request the fake has answered, before the reply is lost.
    const flags: { dropReplies: boolean; afterToken?: () => void } = { dropReplies: false };
    const wrapped: FetchLike = async (input, init) => {
      const res = await fake.fetch(input, init);
      if (input.toString().endsWith("/api/oneon/token")) {
        const drop = flags.dropReplies;
        flags.afterToken?.();
        if (drop) throw new TypeError("fetch failed");
      }
      return res;
    };
    const client = new ImpressoRxClient({
      registrations: repo,
      grants,
      enrolment,
      onSnapshot: (id, snapshot) => snapshots.push({ membershipId: id, snapshot }),
      fetchImpl: wrapped,
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
      const { grantId } = await client.exchangeHandoff(registration.id, handoff, sessionId, identityId, membershipId, staffUserId);
      return { grantId, sessionId, handoff };
    };
    return { flags, wrapped, clock, enrolmentKey, storedValue, control, repo, fake, enrolment, registration, grants, client, launch, advance, snapshots, logged, identityId, membershipId };
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
    await expect(s.client.exchangeHandoff(s.registration.id, handoff, "sess", s.identityId, s.membershipId, "staff-1")).rejects.toBeInstanceOf(
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

  it("releaseGrants forgets the cached tokens of grants revoked in SQL and revokes them at the deployment", async () => {
    const s = await setup();
    const { grantId } = await s.launch();
    const direct = s.client.forGrant(grantId);
    await direct.accessToken(); // cached since the hand-off
    s.grants.revoke(grantId, "identity_merged"); // what a merge's transaction does
    // The row says revoked, but the cached access token would still be used for up to 5 minutes.
    await expect(direct.accessToken()).resolves.toEqual(expect.any(String));

    await s.client.releaseGrants([grantId]);

    await expect(direct.accessToken()).rejects.toBeInstanceOf(ImpressoRxRefusedError);
    expect(s.fake.grants.get(grantId)!.status).toBe("revoked");
    expect(s.grants.find(grantId)).toMatchObject({ status: "revoked", revokedReason: "identity_merged" });
  });

  it("releaseGrants still evicts when the deployment cannot be reached, warns, and never throws", async () => {
    const s = await setup();
    const { grantId } = await s.launch();
    s.grants.revoke(grantId, "identity_unlinked");
    s.fake.networkFailure = true;

    await expect(s.client.releaseGrants([grantId, "unknown-grant"])).resolves.toBeUndefined();

    s.fake.networkFailure = false;
    await expect(s.client.forGrant(grantId).accessToken()).rejects.toBeInstanceOf(ImpressoRxRefusedError);
    expect(s.logged.some((line) => line.includes("Revoking a grant at ImpressoRx failed"))).toBe(true);
    expect(s.logged.join("\n")).not.toContain(s.fake.grantValue(grantId)!);
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

  describe("fix round 1", () => {
    const issueInput = { kind: "action" as const, oneonActionId: "act-1", scope: ["jobs.read"], absoluteExpiresAt: new Date(Date.now() + 86_400_000).toISOString() };

    it("never presents a stored exchange after the idempotency window: revokes locally and at the deployment", async () => {
      const s = await setup();
      const { grantId, sessionId } = await s.launch();
      const calls = s.client.forSession(sessionId)!;
      expireTokens(s);
      s.flags.dropReplies = true;
      await expect(calls.accessToken()).rejects.toBeInstanceOf(ImpressoRxUnreachableError);
      s.flags.dropReplies = false;
      s.advance(121_000);
      await expect(calls.accessToken()).rejects.toBeInstanceOf(ImpressoRxRefusedError);
      expect(s.fake.theftRevocations).toEqual([]);
      expect(s.fake.tokenRequests.filter((r) => r.grantType === "grant").map((r) => r.outcome)).not.toContain("theft");
      expect(s.control.prepare("SELECT status, revoked_reason, pending_request_id FROM delegation_grants WHERE id = ?").get(grantId)).toEqual({
        status: "revoked",
        revoked_reason: "exchange_outcome_unknown",
        pending_request_id: null,
      });
      expect(s.fake.grants.get(grantId)!.status).toBe("revoked");
    });

    it("replays a lost issue reply as that issue, then runs accessToken() as its own exchange", async () => {
      const s = await setup();
      const { sessionId } = await s.launch();
      const calls = s.client.forSession(sessionId)!;
      expireTokens(s);
      s.flags.dropReplies = true;
      await expect(calls.issue(issueInput)).rejects.toBeInstanceOf(ImpressoRxUnreachableError);
      s.flags.dropReplies = false;
      await calls.accessToken();
      expect(s.grants.findActionGrant("act-1")).not.toBeNull();
      expect(s.fake.rotations).toBe(2);
      expect(s.fake.theftRevocations).toEqual([]);
    });

    it("replays a lost grant reply as that grant exchange, then runs issue() as its own exchange", async () => {
      const s = await setup();
      const { sessionId } = await s.launch();
      const calls = s.client.forSession(sessionId)!;
      expireTokens(s);
      s.flags.dropReplies = true;
      await expect(calls.accessToken()).rejects.toBeInstanceOf(ImpressoRxUnreachableError);
      s.flags.dropReplies = false;
      const issued = await calls.issue(issueInput);
      expect(s.grants.findActionGrant("act-1")).toBe(issued.grantId);
      expect(s.fake.rotations).toBe(2);
      expect(s.fake.theftRevocations).toEqual([]);
    });

    it("replays a lost reply for action a1 under a1's key before serving a2", async () => {
      const s = await setup();
      const { sessionId } = await s.launch();
      const calls = s.client.forSession(sessionId)!;
      expireTokens(s);
      s.flags.dropReplies = true;
      await expect(calls.accessToken({ oneonActionId: "a1" })).rejects.toBeInstanceOf(ImpressoRxUnreachableError);
      s.flags.dropReplies = false;
      await calls.accessToken({ oneonActionId: "a2" });
      await calls.accessToken({ oneonActionId: "a1" }); // cached from the replay, no third exchange
      expect(s.fake.rotations).toBe(2);
      expect(s.fake.theftRevocations).toEqual([]);
    });

    it("slides the idle expiry on every exchange", async () => {
      const s = await setup();
      const { sessionId } = await s.launch();
      const calls = s.client.forSession(sessionId)!;
      for (let minutes = 5; minutes <= 45; minutes += 5) {
        s.advance(5 * 60 * 1000);
        await expect(calls.accessToken()).resolves.toEqual(expect.any(String));
      }
    });

    it("refuses a hand-off for another staff user, stores nothing and revokes the issued grant", async () => {
      const s = await setup();
      const handoff = await s.fake.mintHandoff("someone-else");
      await expect(s.client.exchangeHandoff(s.registration.id, handoff, "sess", s.identityId, s.membershipId, "staff-1")).rejects.toBeInstanceOf(
        ImpressoRxRefusedError,
      );
      expect(s.control.prepare("SELECT COUNT(*) AS n FROM delegation_grants").get()).toEqual({ n: 0 });
      expect([...s.fake.grants.values()].every((g) => g.status === "revoked")).toBe(true);
      expect(s.snapshots).toHaveLength(0);
    });

    it("createImpressoRxClient wires the client without exposing the grant store", async () => {
      const s = await setup();
      const client = createImpressoRxClient({
        control: s.control,
        grantMasterKeyB64: randomBytes(32).toString("base64"),
        enrolment: s.enrolment,
        onSnapshot: () => undefined,
        fetchImpl: s.fake.fetch,
        clock: s.clock,
      });
      const handoff = await s.fake.mintHandoff("staff-1");
      const { grantId } = await client.exchangeHandoff(s.registration.id, handoff, "sess-f", s.identityId, s.membershipId, "staff-1");
      expect(client.forSession("sess-f")).not.toBeNull();
      expect(grantId).toEqual(expect.any(String));
    });
  });

  describe("bound session calls", () => {
    it("forBoundSession serves only the session, identity and membership the grant was opened for", async () => {
      const s = await setup();
      const { sessionId } = await s.launch();

      expect(s.client.forBoundSession(sessionId, s.identityId, s.membershipId)).not.toBeNull();
      expect(s.client.forBoundSession("other-session", s.identityId, s.membershipId)).toBeNull();
      expect(s.client.forBoundSession(sessionId, "other-identity", s.membershipId)).toBeNull();
      expect(s.client.forBoundSession(sessionId, s.identityId, "other-membership")).toBeNull();
    });

    it("a bound grant past its idle expiry is not usable: no calls and no active session", async () => {
      const s = await setup();
      const { sessionId } = await s.launch();
      expect(s.client.hasAttendedGrant(sessionId, s.identityId, s.membershipId)).toBe(true);

      s.advance(30 * 60 * 1000 + 1000);

      expect(s.client.hasAttendedGrant(sessionId, s.identityId, s.membershipId)).toBe(false);
      expect(s.client.forBoundSession(sessionId, s.identityId, s.membershipId)).toBeNull();
    });

    it("a bound grant past its absolute expiry is not usable even when its idle expiry slid", async () => {
      const s = await setup();
      const { grantId, sessionId } = await s.launch();
      const calls = s.client.forBoundSession(sessionId, s.identityId, s.membershipId)!;
      // Keep the idle window sliding with a refresh every 5 minutes for just under 12 hours.
      for (let minutes = 0; minutes < 12 * 60 - 5; minutes += 5) {
        s.advance(5 * 60 * 1000);
        await calls.accessToken();
      }
      expect(s.client.hasAttendedGrant(sessionId, s.identityId, s.membershipId)).toBe(true);

      s.advance(10 * 60 * 1000);

      expect(s.grants.find(grantId)!.status).toBe("active"); // the stored grant is untouched; only its use ends
      expect(s.client.hasAttendedGrant(sessionId, s.identityId, s.membershipId)).toBe(false);
      expect(s.client.forBoundSession(sessionId, s.identityId, s.membershipId)).toBeNull();
    });

    it("revokeForMembership revokes every grant of the membership locally and sends nothing", async () => {
      const s = await setup();
      const { grantId, sessionId } = await s.launch();
      const calls = s.client.forBoundSession(sessionId, s.identityId, s.membershipId)!;
      const issued = await calls.issue({ kind: "action", oneonActionId: "act-1", scope: ["jobs.read"], absoluteExpiresAt: new Date(Date.now() + 86_400_000).toISOString() });
      const requestsBefore = s.fake.tokenRequests.length;

      s.client.revokeForMembership(s.membershipId, "membership_suspended");

      expect(s.grants.find(grantId)).toMatchObject({ status: "revoked", revokedReason: "membership_suspended" });
      expect(s.grants.find(issued.grantId)).toMatchObject({ status: "revoked", revokedReason: "membership_suspended" });
      expect(s.client.forBoundSession(sessionId, s.identityId, s.membershipId)).toBeNull();
      await expect(s.client.forGrant(grantId).accessToken()).rejects.toBeInstanceOf(ImpressoRxRefusedError);
      expect(s.fake.tokenRequests.length).toBe(requestsBefore);
    });

    it("revokeForMembership leaves other memberships' grants alone", async () => {
      const s = await setup();
      const { grantId } = await s.launch();

      s.client.revokeForMembership("some-other-membership", "membership_suspended");

      expect(s.grants.find(grantId)!.status).toBe("active");
    });
  });

  describe("action grants", () => {
    const DAY = 24 * 3600 * 1000;
    const bound = (s: Awaited<ReturnType<typeof setup>>, sessionId: string) => s.client.forBoundSession(sessionId, s.identityId, s.membershipId)!;
    const row = (s: Awaited<ReturnType<typeof setup>>, id: string) =>
      s.control.prepare("SELECT idle_expires_at, absolute_expires_at, status, revoked_reason FROM delegation_grants WHERE id = ?").get(id) as {
        idle_expires_at: string;
        absolute_expires_at: string;
        status: string;
        revoked_reason: string | null;
      };

    it("an action grant's idle expiry equals its absolute expiry, however far away that is, and stays so after an exchange", async () => {
      const s = await setup();
      const { sessionId } = await s.launch();
      const absolute = new Date(s.clock().getTime() + 20 * DAY).toISOString();

      const issued = await bound(s, sessionId).issue({ kind: "action", oneonActionId: "act-1", scope: ["jobs.read"], absoluteExpiresAt: absolute });

      expect(row(s, issued.grantId)).toMatchObject({ idle_expires_at: absolute, absolute_expires_at: absolute });
      s.advance(DAY);
      await s.client.forGrant(issued.grantId).accessToken({ oneonActionId: "act-1" });
      expect(row(s, issued.grantId).idle_expires_at).toBe(absolute);
    });

    it("a schedule grant's idle expiry is 14 days or its absolute expiry, whichever comes first", async () => {
      const s = await setup();
      const { sessionId } = await s.launch();
      const far = new Date(s.clock().getTime() + 60 * DAY).toISOString();
      const near = new Date(s.clock().getTime() + 3 * DAY).toISOString();

      const long = await bound(s, sessionId).issue({ kind: "schedule", scope: ["jobs.read"], absoluteExpiresAt: far });
      const short = await bound(s, sessionId).issue({ kind: "schedule", scope: ["jobs.read"], absoluteExpiresAt: near });

      expect(row(s, long.grantId).idle_expires_at).toBe(new Date(s.clock().getTime() + 14 * DAY).toISOString());
      expect(row(s, short.grantId).idle_expires_at).toBe(near);
    });

    it("an issue ImpressoRx refuses (unattended access is off) leaves the attended grant usable", async () => {
      const s = await setup();
      const { grantId, sessionId } = await s.launch();
      s.fake.allowUnattended = false;
      const expires = new Date(s.clock().getTime() + DAY).toISOString();

      await expect(bound(s, sessionId).issue({ kind: "action", oneonActionId: "act-1", scope: ["jobs.read"], absoluteExpiresAt: expires })).rejects.toBeInstanceOf(
        ImpressoRxUnauthorizedError,
      );

      // The refused issue is not left behind as a pending exchange to be replayed (and refused again) by the next token call.
      expect(await bound(s, sessionId).accessToken({ oneonActionId: "act-1" })).toEqual(expect.any(String));
      expect(s.grants.find(grantId)!.status).toBe("active");
      expect(s.fake.theftRevocations).toEqual([]);
      expect(s.fake.tokenRequests.filter((r) => r.grantType === "issue")).toHaveLength(1);
    });

    it("forActionGrant serves the action's own active grant, and nothing for an action without one", async () => {
      const s = await setup();
      const { sessionId } = await s.launch();
      const issued = await bound(s, sessionId).issue({ kind: "action", oneonActionId: "act-1", scope: ["jobs.read"], absoluteExpiresAt: new Date(s.clock().getTime() + DAY).toISOString() });

      expect(s.client.forActionGrant("act-2")).toBeNull();
      expect(await s.client.forActionGrant("act-1")!.accessToken()).toEqual(expect.any(String));
      expect(s.grants.find(issued.grantId)!.status).toBe("active");
    });

    it("revokeActionGrant revokes locally, evicts its tokens and tells ImpressoRx, and a second call sends nothing", async () => {
      const s = await setup();
      const { sessionId } = await s.launch();
      const issued = await bound(s, sessionId).issue({ kind: "action", oneonActionId: "act-1", scope: ["jobs.read"], absoluteExpiresAt: new Date(s.clock().getTime() + DAY).toISOString() });
      await s.client.forActionGrant("act-1")!.accessToken(); // cached
      const rotations = s.fake.rotations;

      await s.client.revokeActionGrant("act-1", "action_completed");

      expect(row(s, issued.grantId)).toMatchObject({ status: "revoked", revoked_reason: "action_completed" });
      expect(s.fake.grants.get(issued.grantId)!.status).toBe("revoked");
      expect(s.client.forActionGrant("act-1")).toBeNull();
      await expect(s.client.forGrant(issued.grantId).accessToken()).rejects.toBeInstanceOf(ImpressoRxRefusedError); // no cached token survives
      expect(s.fake.rotations).toBe(rotations);

      s.fake.grants.get(issued.grantId)!.status = "active";
      await s.client.revokeActionGrant("act-1", "again");
      expect(s.fake.grants.get(issued.grantId)!.status).toBe("active"); // nothing was sent
    });

    it("revokeActionGrant never throws when ImpressoRx cannot be reached: it is revoked here and the failure is logged", async () => {
      const s = await setup();
      const { sessionId } = await s.launch();
      const issued = await bound(s, sessionId).issue({ kind: "action", oneonActionId: "act-1", scope: ["jobs.read"], absoluteExpiresAt: new Date(s.clock().getTime() + DAY).toISOString() });
      s.fake.unavailable = true;

      await expect(s.client.revokeActionGrant("act-1", "action_failed")).resolves.toBeUndefined();

      expect(row(s, issued.grantId).status).toBe("revoked");
      expect(s.logged.join("\n")).toContain("Revoking a grant at ImpressoRx failed");
    });

    it("tRPC carries the action id on an attended grant, so ImpressoRx can attribute the write", async () => {
      const s = await setup();
      const { sessionId } = await s.launch();
      const seen: string[] = [];
      const original = s.fake.fetch;
      vi.spyOn(s.fake, "fetch").mockImplementation(async (input, init) => {
        const auth = new Headers(init?.headers).get("authorization");
        if (String(input).includes("/api/trpc/") && auth) seen.push(String(decodeJwt(auth.slice(7)).oneonActionId));
        return original(input, init);
      });

      await bound(s, sessionId).trpc("inventory.transfer", { n: 1 }, "mutation", { oneonActionId: "act-1" }).catch(() => undefined);

      expect(seen).toEqual(["act-1"]);
    });
  });

  describe("action grants, fix round 1", () => {
    const DAY = 24 * 3600 * 1000;
    const bound = (s: Awaited<ReturnType<typeof setup>>, sessionId: string) => s.client.forBoundSession(sessionId, s.identityId, s.membershipId)!;
    const pendingId = (s: Awaited<ReturnType<typeof setup>>, grantId: string) =>
      (s.control.prepare("SELECT pending_request_id FROM delegation_grants WHERE id = ?").get(grantId) as { pending_request_id: string | null }).pending_request_id;
    const actionRow = (s: Awaited<ReturnType<typeof setup>>, actionId: string) =>
      s.control.prepare("SELECT id, status, revoked_reason FROM delegation_grants WHERE action_id = ?").get(actionId) as
        | { id: string; status: string; revoked_reason: string | null }
        | undefined;
    const issueFor = (s: Awaited<ReturnType<typeof setup>>, sessionId: string, actionId: string) =>
      bound(s, sessionId).issue({ kind: "action", oneonActionId: actionId, scope: ["jobs.read"], absoluteExpiresAt: new Date(s.clock().getTime() + DAY).toISOString() });

    it("a replayed exchange that a suspended tenant refuses stays pending: the value from before the rotation is never presented", async () => {
      const s = await setup();
      const { grantId, sessionId } = await s.launch();
      s.flags.dropReplies = true;
      await expect(bound(s, sessionId).accessToken({ oneonActionId: "act-1" })).rejects.toBeInstanceOf(ImpressoRxUnreachableError); // applied, reply lost
      s.flags.dropReplies = false;
      expect(s.storedValue(grantId)).not.toBe(s.fake.grantValue(grantId)); // ImpressoRx has rotated; Oneon still holds the old value
      const pending = pendingId(s, grantId);
      expect(pending).not.toBeNull();

      s.fake.tenantSuspended = true;
      await expect(bound(s, sessionId).accessToken({ oneonActionId: "act-1" })).rejects.toBeInstanceOf(ImpressoRxUnauthorizedError);
      expect(pendingId(s, grantId)).toBe(pending);

      s.fake.tenantSuspended = false; // the pharmacy is active again
      await expect(bound(s, sessionId).accessToken({ oneonActionId: "act-1" })).resolves.toEqual(expect.any(String));
      expect(s.fake.theftRevocations).toEqual([]);
      expect(s.grants.find(grantId)!.status).toBe("active");
      expect(s.storedValue(grantId)).toBe(s.fake.grantValue(grantId));
    });

    it("a timeout followed by 401s on the retry and on the next key keeps the exchange pending too", async () => {
      const s = await setup();
      const { grantId, sessionId } = await s.launch();
      const newer = await generateEd25519Key();
      s.repo.addPendingOneonKey(s.registration.id, newer.keyId, newer.publicKeyJwk, sealSecret(JSON.stringify(newer.privateKeyJwk), s.enrolmentKey));
      s.fake.oneonKeys.push({ keyId: newer.keyId, publicKeyJwk: newer.publicKeyJwk, retiredAt: null }); // the deployment knows both keys
      // The first attempt is applied and its reply lost; the tenant is suspended before the retry and before the older key is tried.
      s.flags.dropReplies = true;
      s.flags.afterToken = () => {
        s.fake.tenantSuspended = true;
        s.flags.dropReplies = false;
      };

      await expect(bound(s, sessionId).accessToken({ oneonActionId: "act-1" })).rejects.toBeInstanceOf(ImpressoRxUnauthorizedError);

      expect(pendingId(s, grantId)).not.toBeNull();
      expect(s.storedValue(grantId)).not.toBe(s.fake.grantValue(grantId));
      s.flags.afterToken = undefined;
      s.fake.tenantSuspended = false;
      await expect(bound(s, sessionId).accessToken({ oneonActionId: "act-1" })).resolves.toEqual(expect.any(String));
      expect(s.fake.theftRevocations).toEqual([]);
      expect(s.storedValue(grantId)).toBe(s.fake.grantValue(grantId));
    });

    it("a new exchange that every attempt of a suspended tenant refused applied nothing, so it is dropped", async () => {
      const s = await setup();
      const { grantId, sessionId } = await s.launch();
      s.fake.tenantSuspended = true;

      await expect(bound(s, sessionId).accessToken({ oneonActionId: "act-1" })).rejects.toBeInstanceOf(ImpressoRxUnauthorizedError);

      expect(pendingId(s, grantId)).toBeNull();
      s.fake.tenantSuspended = false;
      await expect(bound(s, sessionId).accessToken({ oneonActionId: "act-1" })).resolves.toEqual(expect.any(String));
      expect(s.fake.theftRevocations).toEqual([]);
    });

    it("a grant issued for an action that has already ended is stored revoked, and revoked at ImpressoRx", async () => {
      const s = await setup();
      const { sessionId } = await s.launch();
      await s.client.revokeActionGrant("act-1", "action_cancelled"); // nothing to revoke yet: the action's end is remembered

      const issued = await issueFor(s, sessionId, "act-1");
      const other = await issueFor(s, sessionId, "act-2");

      expect(actionRow(s, "act-1")).toEqual({ id: issued.grantId, status: "revoked", revoked_reason: "action_ended" });
      expect(s.fake.grants.get(issued.grantId)!.status).toBe("revoked");
      expect(s.client.forActionGrant("act-1")).toBeNull();
      expect(actionRow(s, "act-2")).toMatchObject({ id: other.grantId, status: "active" }); // other actions are not affected
    });

    it("an issue whose reply was lost and replays after the action ended also lands revoked", async () => {
      const s = await setup();
      const { sessionId } = await s.launch();
      s.flags.dropReplies = true;
      await expect(issueFor(s, sessionId, "act-1")).rejects.toBeInstanceOf(ImpressoRxUnreachableError); // applied at ImpressoRx, never stored here
      s.flags.dropReplies = false;
      expect(actionRow(s, "act-1")).toBeUndefined();
      await s.client.revokeActionGrant("act-1", "action_cancelled");

      await bound(s, sessionId).accessToken({ oneonActionId: "later" }); // replays the stored issue, then runs its own exchange

      const row = actionRow(s, "act-1")!;
      expect(row).toMatchObject({ status: "revoked", revoked_reason: "action_ended" });
      expect(s.fake.grants.get(row.id)!.status).toBe("revoked");
    });

    it("hadActionGrant tells an action that never had a grant from one whose grant was revoked", async () => {
      const s = await setup();
      const { sessionId } = await s.launch();
      expect(s.client.hadActionGrant("act-1")).toBe(false);
      await issueFor(s, sessionId, "act-1");
      expect(s.client.hadActionGrant("act-1")).toBe(true);
      await s.client.revokeActionGrant("act-1", "action_completed");
      expect(s.client.hadActionGrant("act-1")).toBe(true);
      expect(s.client.hadActionGrant("act-2")).toBe(false);
    });
  });

  describe("which refusals ImpressoRx itself sent", () => {
    const bound = (s: Awaited<ReturnType<typeof setup>>, sessionId: string) => s.client.forBoundSession(sessionId, s.identityId, s.membershipId)!;

    it("a 401 on the token exchange is ImpressoRx's own refusal", async () => {
      const s = await setup();
      const { grantId, sessionId } = await s.launch();
      s.fake.grants.get(grantId)!.status = "revoked";
      expireTokens(s);

      const refusal = await bound(s, sessionId).me().catch((e: unknown) => e);

      expect(refusal).toBeInstanceOf(ImpressoRxUnauthorizedError);
      expect(refusal).toBeInstanceOf(ImpressoRxRefusedError); // existing callers still see a refusal
    });

    it("a 401 from GET /me is ImpressoRx's own refusal", async () => {
      const s = await setup();
      const { grantId, sessionId } = await s.launch();
      s.fake.grants.get(grantId)!.status = "revoked"; // the cached access token is still inside its life: /me itself says 401

      await expect(bound(s, sessionId).me()).rejects.toBeInstanceOf(ImpressoRxUnauthorizedError);
    });

    it.each([404, 400, 302])("a %i from GET /me is a refusal, but not one that revokes anything", async (status) => {
      const s = await setup();
      const { sessionId } = await s.launch();
      s.fake.meStatus = status;

      const refusal = await bound(s, sessionId).me().catch((e: unknown) => e);

      expect(refusal).toBeInstanceOf(ImpressoRxRefusedError);
      expect(refusal).not.toBeInstanceOf(ImpressoRxUnauthorizedError);
      expect(refusal).toMatchObject({ status });
    });

    it("refusals made locally are not ImpressoRx's: an inactive registration, a revoked grant, an expired grant", async () => {
      const s = await setup();
      const { grantId, sessionId } = await s.launch();
      const calls = bound(s, sessionId);

      s.control.prepare("UPDATE tenant_registrations SET status = 'suspended_by_operator' WHERE id = ?").run(s.registration.id);
      const registration = await calls.me().catch((e: unknown) => e);
      expect(registration).toBeInstanceOf(ImpressoRxRefusedError);
      expect(registration).not.toBeInstanceOf(ImpressoRxUnauthorizedError);
      expect(registration).toMatchObject({ message: "Registration is not active" });
      s.control.prepare("UPDATE tenant_registrations SET status = 'active' WHERE id = ?").run(s.registration.id);

      s.advance(31 * 60 * 1000);
      const expired = await calls.me().catch((e: unknown) => e);
      expect(expired).toBeInstanceOf(ImpressoRxRefusedError);
      expect(expired).not.toBeInstanceOf(ImpressoRxUnauthorizedError);

      s.client.revokeForMembership(s.membershipId, "test");
      const revoked = await s.client.forGrant(grantId).me().catch((e: unknown) => e);
      expect(revoked).toBeInstanceOf(ImpressoRxRefusedError);
      expect(revoked).not.toBeInstanceOf(ImpressoRxUnauthorizedError);
    });
  });
});
