import { randomUUID } from "node:crypto";
import { decodeJwt } from "jose";
import { generateEd25519Key, parsePublicJwk, signJws, verifyJws, type GeneratedKey, type JWK } from "../crypto/jws.js";

const IDEMPOTENCY_WINDOW_MS = 120_000;

export type FakeSnapshot = { userId: string; role: string; permissions: string[]; locationIds: string[]; tokenVersion: number; tenantStatus: string };

interface FakeGrant {
  id: string;
  userId: string;
  value: string;
  /** Every value this grant has held before the current one. */
  oldValues: Set<string>;
  generation: number;
  status: "active" | "revoked";
  unattended: boolean;
  scope: string[];
}

interface CachedRotation {
  grantId: string;
  presentedValue: string;
  result: unknown;
  at: number;
}

/**
 * An in-memory ImpressoRx deployment that behaves like the real endpoints
 * (POST /api/oneon/enrol, POST and GET /api/oneon/keys). Every refusal is a bare 401.
 * Tests hand `fake.fetch` to the code under test. It also serves POST /api/oneon/token (handoff, grant, issue), POST /revoke and GET /me, and refuses every tRPC procedure.
 */
export class FakeImpressorx {
  /** Test switches. */
  signReplyWithWrongKey = false;
  replyTenantSlug: string | null = null;
  /** Reply with the deployment JWK as an object instead of a JSON string. */
  replyJwkAsObject = false;
  /** Answer 401 to every POST /api/oneon/keys. */
  refuseKeyAdds = false;
  /** Sign the key list with a key whose kid Oneon has never seen. */
  signListWithUnknownKey = false;
  /** Answer 503 {"error":"Unavailable"} to token, me, revoke and tRPC calls. */
  unavailable = false;
  /** Fail token, me, revoke and tRPC calls at the network level (the fetch rejects). */
  networkFailure = false;
  /** Answer GET /me with this status once its token checks out (a misbehaving deployment: 404, 400, 302). */
  meStatus: number | null = null;
  /** Apply the next token request, then drop the response (the fetch rejects). One-shot. */
  loseNextTokenResponse = false;
  /** Whether grantType "issue" is allowed. */
  allowUnattended = true;
  /**
   * The tenant is not Active: every token request is refused with a bare 401 that revokes nothing and counts as no theft, before the
   * idempotent replay is looked at (ImpressoRx's decideExchange).
   */
  tenantSuspended = false;
  /** Snapshot returned for a staff user; unknown users get a default one. */
  readonly snapshots = new Map<string, FakeSnapshot>();
  /** Every token request the server saw, for assertions. */
  readonly tokenRequests: Array<{ grantType: string; requestId: string; kid: string; jti: string; outcome: "ok" | "cached" | "theft" | "refused" }> = [];
  /** Rotations actually applied (cache replays do not count). */
  rotations = 0;
  readonly theftRevocations: string[] = [];
  readonly grants = new Map<string, FakeGrant>();

  readonly oneonKeys: Array<{ keyId: string; publicKeyJwk: JWK; retiredAt: Date | null }> = [];
  readonly acceptedOneonKeyIds: string[] = [];
  private readonly deploymentKeys: Array<GeneratedKey & { retiredAt: Date | null }> = [];
  private codeUsed = false;
  private readonly seenJtis = new Set<string>();
  private readonly cache = new Map<string, CachedRotation>();
  private readonly issuer: string;

  constructor(
    readonly origin: string,
    readonly tenantSlug: string,
    private readonly code: string,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.issuer = `impressorx:${tenantSlug}`;
  }

  get active(): boolean {
    return this.codeUsed;
  }

  /** The deployment adds a signing key of its own; the older key is retired in 7 days. */
  async rotateDeploymentKey(): Promise<GeneratedKey> {
    const key = await generateEd25519Key();
    for (const old of this.deploymentKeys) {
      if (!old.retiredAt) old.retiredAt = new Date(this.clock().getTime() + 7 * 24 * 60 * 60 * 1000);
    }
    this.deploymentKeys.push({ ...key, retiredAt: null });
    return key;
  }

  readonly fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input.toString());
    const method = init?.method ?? "GET";
    if (url.origin !== this.origin) return new Response(null, { status: 404 });
    try {
      if (method === "POST" && url.pathname === "/api/oneon/enrol") return await this.enrol(init);
      if (method === "POST" && url.pathname === "/api/oneon/keys") return await this.addOneonKey(init);
      if (method === "GET" && url.pathname === "/api/oneon/keys") return await this.listKeys();
      const protectedPath =
        url.pathname === "/api/oneon/token" || url.pathname === "/api/oneon/revoke" || url.pathname === "/api/oneon/me" || url.pathname.startsWith("/api/trpc/");
      if (protectedPath && this.networkFailure) throw new TypeError("fetch failed");
      if (protectedPath && this.unavailable) return unavailableResponse();
      if (method === "POST" && url.pathname === "/api/oneon/token") return await this.token(init);
      if (method === "POST" && url.pathname === "/api/oneon/revoke") return await this.revokeEndpoint(init);
      if (method === "GET" && url.pathname === "/api/oneon/me") return await this.me(init);
      // B-core: every tRPC procedure refuses agents.
      if (url.pathname.startsWith("/api/trpc/")) return (await this.bearerGrant(init)) ? forbidden() : unauthorized();
    } catch (error) {
      if (error instanceof TypeError) throw error;
      return unauthorized();
    }
    return new Response(null, { status: 404 });
  };

  private async enrol(init?: RequestInit): Promise<Response> {
    if (this.codeUsed) return unauthorized();
    const token = requestToken(init);
    const unverified = decodeJwt(token) as { oneonPublicKeyJwk?: unknown; oneonKeyId?: string };
    // Like the real endpoint: the JWK must be a JSON string holding a public Ed25519 key.
    const oneonJwk = parsePublicJwk(unverified.oneonPublicKeyJwk);
    if (!oneonJwk) return unauthorized();
    const { payload, kid } = await verifyJws(token, {
      resolveKey: (k) => (k === unverified.oneonKeyId ? oneonJwk : null),
      issuer: "oneon",
      audience: this.issuer,
      now: this.clock(),
    });
    if (payload.code !== this.code || typeof payload.nonce !== "string") return unauthorized();
    if (typeof payload.oneonOrigin !== "string" || !payload.oneonOrigin.startsWith("https://")) return unauthorized();
    this.codeUsed = true;
    this.oneonKeys.push({ keyId: kid, publicKeyJwk: oneonJwk, retiredAt: null });
    const key = await this.rotateDeploymentKey();

    const signer = this.signReplyWithWrongKey ? await generateEd25519Key() : key;
    const response = await signJws({
      privateKeyJwk: signer.privateKeyJwk,
      kid: key.keyId,
      iss: this.issuer,
      aud: "oneon",
      now: this.clock(),
      claims: {
        nonce: payload.nonce,
        tenantSlug: this.replyTenantSlug ?? this.tenantSlug,
        deploymentKeyId: key.keyId,
        deploymentPublicKeyJwk: this.replyJwkAsObject ? key.publicKeyJwk : JSON.stringify(key.publicKeyJwk),
      },
    });
    return json({ response });
  }

  private async addOneonKey(init?: RequestInit): Promise<Response> {
    if (!this.codeUsed || this.refuseKeyAdds) return unauthorized();
    const now = this.clock();
    const { payload, kid } = await verifyJws(requestToken(init), {
      // A key that is retiring is refused, like the real endpoint.
      resolveKey: (k) => this.oneonKeys.find((o) => o.keyId === k && !o.retiredAt)?.publicKeyJwk ?? null,
      issuer: "oneon",
      audience: this.issuer,
      now,
    });
    const newJwk = parsePublicJwk(payload.newPublicKeyJwk);
    if (typeof payload.newKeyId !== "string" || !newJwk) return unauthorized();
    this.acceptedOneonKeyIds.push(kid);
    for (const key of this.oneonKeys) {
      if (!key.retiredAt) key.retiredAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    }
    this.oneonKeys.push({ keyId: payload.newKeyId, publicKeyJwk: newJwk, retiredAt: null });
    return new Response(null, { status: 204 });
  }


  /** A hand-off JWS as ImpressoRx would mint it for a staff user (signed by the oldest valid deployment key). */
  async mintHandoff(staffUserId: string, overrides: { ttlSeconds?: number; audience?: string; issuer?: string } = {}): Promise<string> {
    const signer = this.deploymentKeys[0]!;
    const snapshot = this.snapshotFor(staffUserId);
    return signJws({
      privateKeyJwk: signer.privateKeyJwk,
      kid: signer.keyId,
      iss: overrides.issuer ?? this.issuer,
      aud: overrides.audience ?? "oneon",
      now: this.clock(),
      ttlSeconds: overrides.ttlSeconds ?? 60,
      claims: { sub: staffUserId, tenantSlug: this.tenantSlug, tv: snapshot.tokenVersion, role: snapshot.role },
    });
  }

  /** Test helper: the current value of a grant (what Oneon should hold). */
  grantValue(grantId: string): string | undefined {
    return this.grants.get(grantId)?.value;
  }

  private snapshotFor(userId: string): FakeSnapshot {
    return this.snapshots.get(userId) ?? { userId, role: "manager", permissions: ["jobs.read"], locationIds: ["loc-1"], tokenVersion: 1, tenantStatus: "active" };
  }

  private consumeJti = (jti: string): boolean => {
    if (this.seenJtis.has(jti)) return false;
    this.seenJtis.add(jti);
    return true;
  };

  private async verifyOneonRequest(init?: RequestInit): Promise<{ payload: Record<string, unknown>; kid: string; jti: string }> {
    const now = this.clock();
    const { payload, kid } = await verifyJws(requestToken(init), {
      resolveKey: (k) => this.oneonKeys.find((o) => o.keyId === k && (!o.retiredAt || o.retiredAt > now))?.publicKeyJwk ?? null,
      issuer: "oneon",
      audience: this.issuer,
      now,
      consumeJti: this.consumeJti,
    });
    return { payload, kid, jti: payload.jti as string };
  }

  private async mintAccessToken(grant: FakeGrant, oneonActionId?: string): Promise<{ accessToken: string; accessTokenExpiresAt: string }> {
    const signer = this.deploymentKeys[0]!;
    const now = this.clock();
    const accessToken = await signJws({
      privateKeyJwk: signer.privateKeyJwk,
      kid: signer.keyId,
      iss: this.issuer,
      aud: this.issuer,
      now,
      ttlSeconds: 300,
      claims: {
        sub: grant.userId,
        tv: this.snapshotFor(grant.userId).tokenVersion,
        grantId: grant.id,
        unattended: grant.unattended,
        scope: grant.scope,
        ...(oneonActionId ? { oneonActionId } : {}),
      },
    });
    return { accessToken, accessTokenExpiresAt: new Date(now.getTime() + 300_000).toISOString() };
  }

  private theft(grant: FakeGrant): void {
    grant.status = "revoked";
    this.theftRevocations.push(grant.id);
  }

  private async token(init?: RequestInit): Promise<Response> {
    if (!this.codeUsed) return unauthorized();
    const { payload, kid, jti } = await this.verifyOneonRequest(init);
    const grantType = String(payload.grantType);
    const requestId = payload.requestId;
    const log = (outcome: "ok" | "cached" | "theft" | "refused") => this.tokenRequests.push({ grantType, requestId: String(requestId), kid, jti, outcome });
    if (typeof requestId !== "string") {
      log("refused");
      return unauthorized();
    }
    if (this.tenantSuspended) {
      log("refused");
      return unauthorized();
    }
    const dropResponse = this.loseNextTokenResponse;
    const reply = (body: unknown): Response => {
      if (dropResponse) {
        this.loseNextTokenResponse = false;
        throw new TypeError("fetch failed");
      }
      return json(body);
    };

    if (grantType === "handoff") {
      const handoff = await this.verifyHandoff(payload.handoff);
      if (!handoff) {
        log("refused");
        return unauthorized();
      }
      const grant = this.newGrant(handoff.sub, false, []);
      const result = { ...(await this.mintAccessToken(grant)), grant: { id: grant.id, value: grant.value, generation: grant.generation }, snapshot: this.snapshotFor(grant.userId) };
      log("ok");
      return reply(result);
    }

    const grantId = grantType === "issue" ? payload.attendedGrantId : payload.grantId;
    const presented = grantType === "issue" ? payload.attendedGrant : payload.grant;
    const grant = typeof grantId === "string" ? this.grants.get(grantId) : undefined;
    if (!grant || typeof presented !== "string" || (grantType !== "grant" && grantType !== "issue")) {
      log("refused");
      return unauthorized();
    }
    const now = this.clock().getTime();
    const cached = this.cache.get(requestId);
    if (cached) {
      // Same request id: identical result only for the same value inside the window; anything else is theft.
      if (cached.grantId === grant.id && cached.presentedValue === presented && now - cached.at <= IDEMPOTENCY_WINDOW_MS && grant.status === "active") {
        log("cached");
        return reply(cached.result);
      }
      this.theft(grant);
      log("theft");
      return unauthorized();
    }
    if (grant.status !== "active") {
      log("refused");
      return unauthorized();
    }
    if (presented !== grant.value) {
      const stale = grant.oldValues.has(presented);
      if (stale) this.theft(grant);
      log(stale ? "theft" : "refused");
      return unauthorized();
    }
    const issueInvalid =
      grantType === "issue" &&
      (!this.allowUnattended ||
        (payload.kind !== "action" && payload.kind !== "schedule") ||
        !Array.isArray(payload.scope) ||
        typeof payload.absoluteExpiresAt !== "string" ||
        (payload.kind === "action" && typeof payload.oneonActionId !== "string"));
    if (issueInvalid) {
      log("refused");
      return unauthorized();
    }

    // Rotate the presented grant.
    grant.oldValues.add(grant.value);
    grant.value = randomUUID();
    grant.generation += 1;
    this.rotations += 1;
    const actionId = typeof payload.oneonActionId === "string" ? payload.oneonActionId : undefined;
    const result: Record<string, unknown> = {
      ...(await this.mintAccessToken(grant, grantType === "grant" ? actionId : undefined)),
      grant: { id: grant.id, value: grant.value, generation: grant.generation },
      snapshot: this.snapshotFor(grant.userId),
    };
    if (grantType === "issue") {
      const issued = this.newGrant(grant.userId, true, payload.scope as string[]);
      result.issued = { id: issued.id, value: issued.value, generation: issued.generation };
    }
    this.cache.set(requestId, { grantId: grant.id, presentedValue: presented, result, at: now });
    log("ok");
    return reply(result);
  }

  private newGrant(userId: string, unattended: boolean, scope: string[]): FakeGrant {
    const grant: FakeGrant = { id: randomUUID(), userId, value: randomUUID(), oldValues: new Set(), generation: 1, status: "active", unattended, scope };
    this.grants.set(grant.id, grant);
    return grant;
  }

  private async verifyHandoff(handoff: unknown): Promise<{ sub: string } | null> {
    if (typeof handoff !== "string") return null;
    try {
      const { payload } = await verifyJws(handoff, {
        resolveKey: (k) => this.deploymentKeys.find((d) => d.keyId === k)?.publicKeyJwk ?? null,
        issuer: this.issuer,
        audience: "oneon",
        maxTtlSeconds: 60,
        now: this.clock(),
        consumeJti: this.consumeJti,
      });
      return typeof payload.sub === "string" ? { sub: payload.sub } : null;
    } catch {
      return null;
    }
  }

  private async revokeEndpoint(init?: RequestInit): Promise<Response> {
    if (!this.codeUsed) return unauthorized();
    const { payload } = await this.verifyOneonRequest(init);
    const grant = typeof payload.grantId === "string" ? this.grants.get(payload.grantId) : undefined;
    if (!grant) return unauthorized();
    grant.status = "revoked";
    return new Response(null, { status: 204 });
  }

  /** The active grant behind a Bearer access token, or null. */
  private async bearerGrant(init?: RequestInit): Promise<FakeGrant | null> {
    const header = new Headers(init?.headers).get("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return null;
    try {
      const { payload } = await verifyJws(token, {
        resolveKey: (k) => this.deploymentKeys.find((d) => d.keyId === k)?.publicKeyJwk ?? null,
        issuer: this.issuer,
        audience: this.issuer,
        now: this.clock(),
      });
      const grant = this.grants.get(String(payload.grantId));
      return grant && grant.status === "active" ? grant : null;
    } catch {
      return null;
    }
  }

  private async me(init?: RequestInit): Promise<Response> {
    const grant = await this.bearerGrant(init);
    if (!grant) return unauthorized();
    if (this.meStatus !== null) return new Response(null, { status: this.meStatus });
    return json({ ...this.snapshotFor(grant.userId), name: grant.userId, oneonStatus: "active" });
  }

  private async listKeys(): Promise<Response> {
    if (!this.codeUsed) return unauthorized();
    const now = this.clock();
    // The OLDEST still-valid key signs the list, so a verifier that knows only older keys can still accept it.
    const signer = this.deploymentKeys.find((k) => !k.retiredAt || k.retiredAt > now)!;
    const keys = this.deploymentKeys
      .filter((k) => !k.retiredAt || k.retiredAt > now)
      .map((k) => ({ keyId: k.keyId, publicKeyJwk: JSON.stringify(k.publicKeyJwk), retiresAt: k.retiredAt?.toISOString() ?? null }));
    const usedSigner = this.signReplyWithWrongKey || this.signListWithUnknownKey ? await generateEd25519Key() : signer;
    const signerKid = this.signListWithUnknownKey ? randomUUID() : signer.keyId;
    const response = await signJws({
      privateKeyJwk: usedSigner.privateKeyJwk,
      kid: signerKid,
      iss: this.issuer,
      aud: "oneon",
      now,
      claims: { keys, nonce: randomUUID() },
    });
    return json({ response });
  }
}

function requestToken(init?: RequestInit): string {
  const body = JSON.parse(String(init?.body)) as { request?: unknown };
  if (typeof body.request !== "string") throw new Error("no request");
  return body.request;
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const unavailableResponse = () =>
  new Response(JSON.stringify({ error: "Unavailable" }), { status: 503, headers: { "content-type": "application/json" } });
const forbidden = () =>
  new Response(JSON.stringify({ error: { json: { message: "FORBIDDEN", data: { code: "FORBIDDEN" } } } }), {
    status: 403,
    headers: { "content-type": "application/json" },
  });
const unauthorized = () =>
  new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
