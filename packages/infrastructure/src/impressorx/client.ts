import { randomUUID } from "node:crypto";
import type { Logger } from "@oneon/domain";
import { signJws } from "../crypto/jws.js";
import { GrantInactiveError, GrantStore, type GrantRecord, type InsertGrant, type PendingOp } from "../database/control/grant-store.js";
import type { ControlDb } from "../database/control/open-control-db.js";
import { TenantRegistrationRepository } from "../database/control/tenant-registration-repository.js";
import type { TenantRegistration } from "../database/control/tenant-registration-repository.js";
import type { EnrolmentService, FetchLike } from "./enrolment-service.js";

export type MembershipSnapshot = {
  userId: string;
  role: string;
  permissions: string[];
  locationIds: string[];
  tokenVersion: number;
  tenantStatus: string;
};

/** ImpressoRx refused the call (401 from every signing key, or a refused Bearer token / procedure). */
export class ImpressoRxRefusedError extends Error {
  constructor(
    message = "ImpressoRx refused the request",
    readonly status = 401,
  ) {
    super(message);
    this.name = "ImpressoRxRefusedError";
  }
}

/** Network failure, timeout or 5xx: infrastructure, never a revocation. */
export class ImpressoRxUnreachableError extends Error {
  constructor(message = "ImpressoRx is unreachable") {
    super(message);
    this.name = "ImpressoRxUnreachableError";
  }
}

export interface GrantCalls {
  accessToken(opts?: { oneonActionId?: string }): Promise<string>;
  me(): Promise<MembershipSnapshot>;
  revoke(): Promise<void>;
  trpc<T>(path: string, input: unknown, type: "query" | "mutation"): Promise<T>;
}

export interface SessionCalls extends GrantCalls {
  issue(input: { kind: "action" | "schedule"; oneonActionId?: string; scope: string[]; absoluteExpiresAt: string }): Promise<{ grantId: string }>;
}

export interface ImpressoRxClientDeps {
  registrations: TenantRegistrationRepository;
  grants: GrantStore;
  /** Supplies the Oneon signing keys, newest first. */
  enrolment: Pick<EnrolmentService, "oneonSigningKeys">;
  /** Called after every successful exchange and after me(), so the membership snapshot stays fresh (spec 4.6). */
  onSnapshot: (membershipId: string, snapshot: MembershipSnapshot) => void;
  fetchImpl?: FetchLike;
  clock?: () => Date;
  logger?: Logger;
  /** Pause between retries of a transient failure. */
  sleep?: (ms: number) => Promise<void>;
}

const REQUEST_TIMEOUT_MS = 10_000;
/** The deployment answers a repeated request id from its cache for 120 s; stop before that. */
const RETRY_WINDOW_MS = 110_000;
/** Safety margin before the window closes: no attempt is started at or after (window - margin) since the exchange began. */
const RETRY_MARGIN_MS = 10_000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;
const TOKEN_REFRESH_MARGIN_MS = 30_000;
const ATTENDED_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
const ATTENDED_IDLE_MS = 30 * 60 * 1000;
const UNATTENDED_IDLE_MS = 14 * 24 * 60 * 60 * 1000;

type GrantTriple = { id: string; value: string; generation: number };
type TokenResponse = {
  accessToken: string;
  accessTokenExpiresAt: string;
  grant: GrantTriple;
  snapshot: MembershipSnapshot;
  issued?: GrantTriple;
};

const sleepReal = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class ImpressoRxClient {
  private readonly fetchImpl: FetchLike;
  private readonly clock: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<string>>();
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: ImpressoRxClientDeps) {
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
    this.clock = deps.clock ?? (() => new Date());
    this.sleep = deps.sleep ?? sleepReal;
  }

  /**
   * Trades a hand-off for an Attended grant. NOT idempotent at ImpressoRx: an ambiguous failure is surfaced, and the
   * person relaunches from ImpressoRx. A 401 from one signing key moves on to the next signing key.
   */
  async exchangeHandoff(
    registrationId: string,
    handoff: string,
    sessionId: string,
    identityId: string,
    membershipId: string,
    expectedExternalUserId: string,
  ): Promise<{ grantId: string; snapshot: MembershipSnapshot }> {
    const registration = this.registration(registrationId);
    const res = await this.postToken(registration, { grantType: "handoff", handoff, requestId: randomUUID() }, false);
    if (res.snapshot.userId !== expectedExternalUserId) {
      await this.bestEffortRevoke(registration, res.grant.id);
      throw new ImpressoRxRefusedError("Hand-off is for a different user");
    }
    const now = this.clock().getTime();
    this.deps.grants.insert({
      id: res.grant.id,
      identityId,
      membershipId,
      tenantRegistrationId: registrationId,
      kind: "attended",
      scope: [],
      value: res.grant.value,
      generation: res.grant.generation,
      sessionId,
      idleExpiresAt: new Date(now + ATTENDED_IDLE_MS).toISOString(),
      absoluteExpiresAt: new Date(now + ATTENDED_ABSOLUTE_MS).toISOString(),
    });
    this.cacheToken(res.grant.id, undefined, res);
    this.deps.onSnapshot(membershipId, res.snapshot);
    return { grantId: res.grant.id, snapshot: res.snapshot };
  }

  /** Attended calls for a request handler's session; null when the session holds no active attended grant. */
  forSession(sessionId: string): SessionCalls | null {
    const grant = this.deps.grants.findAttendedForSession(sessionId);
    return grant ? new Handle(this, grant.id) : null;
  }

  /** True while this session holds an active attended grant opened for exactly this identity and membership. */
  hasAttendedGrant(sessionId: string, identityId: string, membershipId: string): boolean {
    return this.deps.grants.findAttendedForSessionBound(sessionId, identityId, membershipId) !== null;
  }

  /** Unattended calls (actions, schedules). */
  forGrant(grantId: string): GrantCalls {
    return new Handle(this, grantId);
  }

  // ---- used by Handle ----

  /** @internal */
  accessToken(grantId: string, oneonActionId?: string): Promise<string> {
    const key = tokenKey(grantId, oneonActionId);
    const cached = this.cachedToken(key);
    if (cached) return Promise.resolve(cached);
    const running = this.inflight.get(key);
    if (running) return running;
    const promise = this.serialised(grantId, async () => {
      const again = this.cachedToken(key);
      if (again) return again;
      return (await this.runExchange(grantId, oneonActionId ? { grantType: "grant", oneonActionId } : { grantType: "grant" })).accessToken;
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  /** @internal */
  async me(grantId: string): Promise<MembershipSnapshot> {
    const record = this.activeGrant(grantId);
    const registration = this.registration(record.tenantRegistrationId);
    const token = await this.accessToken(grantId);
    const res = await this.bearerFetch(`${registration.origin}/api/oneon/me`, token, { method: "GET" });
    if (res.status === 401) this.tokens.delete(tokenKey(grantId));
    this.throwForStatus(res.status);
    const snapshot = parseSnapshot((await res.json().catch(() => null)) as Partial<MembershipSnapshot> | null);
    if (!snapshot) throw new ImpressoRxUnreachableError("Malformed /me reply");
    this.deps.onSnapshot(record.membershipId, snapshot);
    return snapshot;
  }

  /** @internal Revokes locally first, so a grant is never used again even if the deployment cannot be reached. */
  async revoke(grantId: string): Promise<void> {
    const record = this.deps.grants.find(grantId);
    if (!record) return;
    this.deps.grants.revoke(grantId, "revoked_by_oneon");
    this.dropTokens(grantId);
    await this.signedPost(this.registration(record.tenantRegistrationId), "/api/oneon/revoke", { grantId }, true);
  }

  /**
   * @internal tRPC with the Bearer token. A refusal here (FORBIDDEN while no procedure allows agents, or 401) is a
   * refusal for this call only; it never revokes the grant.
   */
  async trpc<T>(grantId: string, path: string, input: unknown, type: "query" | "mutation"): Promise<T> {
    const record = this.activeGrant(grantId);
    const registration = this.registration(record.tenantRegistrationId);
    const token = await this.accessToken(grantId);
    const base = `${registration.origin}/api/trpc/${path}`;
    // ImpressoRx's tRPC uses the superjson envelope: input is sent as { json } and the result comes back as { json }.
    const wrapped = input === undefined ? undefined : { json: input };
    const res =
      type === "query"
        ? await this.bearerFetch(wrapped === undefined ? base : `${base}?input=${encodeURIComponent(JSON.stringify(wrapped))}`, token, { method: "GET" })
        : await this.bearerFetch(base, token, { method: "POST", body: JSON.stringify(wrapped ?? {}), contentType: true });
    this.throwForStatus(res.status);
    const body = (await res.json().catch(() => null)) as { result?: { data?: Record<string, unknown> } } | null;
    const data = body?.result?.data;
    if (data === undefined || data === null) throw new ImpressoRxUnreachableError("Malformed tRPC reply");
    return ("json" in data ? data.json : data) as T;
  }

  /** @internal */
  async issue(
    attendedGrantId: string,
    input: { kind: "action" | "schedule"; oneonActionId?: string; scope: string[]; absoluteExpiresAt: string },
  ): Promise<{ grantId: string }> {
    const op: PendingOp = {
      grantType: "issue",
      kind: input.kind,
      ...(input.oneonActionId ? { oneonActionId: input.oneonActionId } : {}),
      scope: input.scope,
      absoluteExpiresAt: input.absoluteExpiresAt,
    };
    const out = await this.serialised(attendedGrantId, () => this.runExchange(attendedGrantId, op));
    return { grantId: out.issuedGrantId! };
  }

  // ---- internals ----

  /**
   * Runs `op` as an exchange of the grant. A stored pending exchange (a lost reply or a crash) is replayed FIRST,
   * exactly as stored (same request id, same value, same operation) and its result applied to that operation; then `op`
   * runs as a new exchange. A stored exchange past the idempotency window is never presented: the grant is revoked.
   */
  private async runExchange(grantId: string, op: PendingOp): Promise<{ accessToken: string; issuedGrantId?: string }> {
    for (;;) {
      const record = this.activeGrant(grantId);
      const registration = this.registration(record.tenantRegistrationId);
      const begin = this.beginExchange(grantId, op);
      if (begin.reused && this.clock().getTime() - Date.parse(begin.pendingSince) >= RETRY_WINDOW_MS - RETRY_MARGIN_MS) {
        this.deps.grants.revoke(grantId, "exchange_outcome_unknown");
        this.dropTokens(grantId);
        await this.bestEffortRevoke(registration, grantId);
        throw new ImpressoRxRefusedError("An earlier exchange has an unknown outcome");
      }
      const out = await this.perform(record, registration, begin);
      if (JSON.stringify(begin.pendingOp) === JSON.stringify(op)) return out;
    }
  }

  private async perform(
    record: GrantRecord,
    registration: TenantRegistration,
    begin: { value: string; requestId: string; pendingSince: string; pendingOp: PendingOp },
  ): Promise<{ accessToken: string; issuedGrantId?: string }> {
    const op = begin.pendingOp;
    const claims: Record<string, unknown> =
      op.grantType === "issue"
        ? {
            grantType: "issue",
            attendedGrantId: record.id,
            attendedGrant: begin.value,
            requestId: begin.requestId,
            kind: op.kind,
            scope: op.scope,
            ...(op.oneonActionId ? { oneonActionId: op.oneonActionId } : {}),
            absoluteExpiresAt: op.absoluteExpiresAt,
          }
        : {
            grantType: "grant",
            grantId: record.id,
            grant: begin.value,
            requestId: begin.requestId,
            ...(op.oneonActionId ? { oneonActionId: op.oneonActionId } : {}),
          };
    const res = await this.postToken(registration, claims, true, Date.parse(begin.pendingSince));

    let issued: InsertGrant | undefined;
    if (op.grantType === "issue" && res.issued) {
      const now = this.clock().getTime();
      issued = {
        id: res.issued.id,
        identityId: record.identityId,
        membershipId: record.membershipId,
        tenantRegistrationId: record.tenantRegistrationId,
        kind: op.kind,
        scope: op.scope,
        value: res.issued.value,
        generation: res.issued.generation,
        actionId: op.oneonActionId,
        idleExpiresAt: new Date(Math.min(now + UNATTENDED_IDLE_MS, Date.parse(op.absoluteExpiresAt))).toISOString(),
        absoluteExpiresAt: op.absoluteExpiresAt,
      };
    }
    // The rotation is always completed, even when the reply turns out to be unusable.
    this.complete(record.id, begin.requestId, res, issued);
    this.cacheToken(record.id, op.grantType === "grant" ? op.oneonActionId : undefined, res);
    this.deps.onSnapshot(record.membershipId, res.snapshot);
    if (op.grantType === "issue" && !issued) throw new ImpressoRxUnreachableError("Reply carries no issued grant");
    return { accessToken: res.accessToken, issuedGrantId: issued?.id };
  }

  private dropTokens(grantId: string): void {
    for (const key of [...this.tokens.keys()]) if (key.startsWith(`${grantId}:`)) this.tokens.delete(key);
  }

  private async bestEffortRevoke(registration: TenantRegistration, grantId: string): Promise<void> {
    try {
      await this.signedPost(registration, "/api/oneon/revoke", { grantId }, false);
    } catch {
      // The grant is already unusable on this side.
    }
  }

  private beginExchange(grantId: string, op: PendingOp) {
    try {
      return this.deps.grants.beginExchange(grantId, op);
    } catch (error) {
      if (error instanceof GrantInactiveError) throw new ImpressoRxRefusedError("Grant is not active");
      throw error;
    }
  }

  private complete(grantId: string, requestId: string, res: TokenResponse, issued?: InsertGrant): void {
    try {
      this.deps.grants.completeExchange(grantId, requestId, res.grant.value, res.grant.generation, issued);
    } catch (error) {
      if (error instanceof GrantInactiveError) throw new ImpressoRxRefusedError("Grant is not active");
      throw error;
    }
  }

  private activeGrant(grantId: string): GrantRecord {
    const record = this.deps.grants.find(grantId);
    if (!record || record.status !== "active") throw new ImpressoRxRefusedError("Grant is not active");
    const now = this.clock().getTime();
    if (Date.parse(record.absoluteExpiresAt) <= now || (record.idleExpiresAt && Date.parse(record.idleExpiresAt) <= now)) {
      throw new ImpressoRxRefusedError("Grant has expired");
    }
    return record;
  }

  private registration(id: string): TenantRegistration {
    const registration = this.deps.registrations.findById(id);
    if (!registration || registration.status !== "active") throw new ImpressoRxRefusedError("Registration is not active");
    return registration;
  }

  /** One exchange at a time per grant: this promise chain sits in front of the database lock. */
  private serialised<T>(grantId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(grantId) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.chains.set(grantId, tail);
    void tail.then(() => {
      if (this.chains.get(grantId) === tail) this.chains.delete(grantId);
    });
    return run;
  }

  private cachedToken(key: string): string | null {
    const entry = this.tokens.get(key);
    return entry && entry.expiresAt - TOKEN_REFRESH_MARGIN_MS > this.clock().getTime() ? entry.token : null;
  }

  private cacheToken(grantId: string, oneonActionId: string | undefined, res: TokenResponse): void {
    this.tokens.set(tokenKey(grantId, oneonActionId), { token: res.accessToken, expiresAt: Date.parse(res.accessTokenExpiresAt) });
  }

  private async postToken(registration: TenantRegistration, claims: Record<string, unknown>, retry: boolean, since?: number): Promise<TokenResponse> {
    const res = await this.signedPost(registration, "/api/oneon/token", claims, retry, since);
    const parsed = parseTokenResponse(await res.json().catch(() => null));
    if (!parsed) throw new ImpressoRxUnreachableError("Malformed token reply");
    return parsed;
  }

  /**
   * Signed POST to the deployment. Each attempt is a FRESH outer JWS (new jti) with the SAME claims (so the same
   * requestId and grant value). 401: try the next (older) signing key, in case the newest is not known to the
   * deployment yet; 401 from every key is a refusal. Network failure, timeout, 5xx and 429 are retried (when `retry`)
   * while inside the retry window, then reported as unreachable.
   */
  private async signedPost(registration: TenantRegistration, path: string, claims: Record<string, unknown>, retry: boolean, since?: number): Promise<Response> {
    const keys = this.deps.enrolment.oneonSigningKeys(registration.id);
    const started = since ?? this.clock().getTime();
    for (const key of keys) {
      for (let attempt = 1; ; attempt++) {
        const request = await signJws({
          privateKeyJwk: key.privateKeyJwk,
          kid: key.keyId,
          iss: "oneon",
          aud: `impressorx:${registration.tenantSlug}`,
          now: this.clock(),
          ttlSeconds: 60,
          claims,
        });
        let res: Response | null = null;
        try {
          res = await this.fetchImpl(`${registration.origin}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ request }),
            redirect: "manual",
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
        } catch {
          res = null;
        }
        const status = res?.status ?? null;
        if (res && (status === 200 || status === 204)) return res;
        if (status === 401) break;
        if (status !== null && status < 500 && status !== 429) throw new ImpressoRxRefusedError(`ImpressoRx answered ${status}`, status);
        const elapsed = this.clock().getTime() - started;
        if (!retry || attempt >= MAX_ATTEMPTS || elapsed + RETRY_DELAY_MS * attempt + RETRY_MARGIN_MS >= RETRY_WINDOW_MS) {
          this.deps.logger?.warn("ImpressoRx unreachable", { path, status });
          throw new ImpressoRxUnreachableError();
        }
        await this.sleep(RETRY_DELAY_MS * attempt);
      }
    }
    this.deps.logger?.warn("ImpressoRx refused a signed request", { path });
    throw new ImpressoRxRefusedError();
  }

  private async bearerFetch(url: string, token: string, init: { method: "GET" | "POST"; body?: string; contentType?: boolean }): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        method: init.method,
        headers: { authorization: `Bearer ${token}`, ...(init.contentType ? { "content-type": "application/json" } : {}) },
        body: init.body,
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ImpressoRxUnreachableError();
    }
  }

  private throwForStatus(status: number): void {
    if (status >= 200 && status < 300) return;
    if (status >= 500 || status === 429) throw new ImpressoRxUnreachableError();
    throw new ImpressoRxRefusedError(`ImpressoRx answered ${status}`, status);
  }
}

class Handle implements SessionCalls {
  constructor(
    private readonly client: ImpressoRxClient,
    private readonly grantId: string,
  ) {}
  accessToken(opts?: { oneonActionId?: string }): Promise<string> {
    return this.client.accessToken(this.grantId, opts?.oneonActionId);
  }
  me(): Promise<MembershipSnapshot> {
    return this.client.me(this.grantId);
  }
  revoke(): Promise<void> {
    return this.client.revoke(this.grantId);
  }
  trpc<T>(path: string, input: unknown, type: "query" | "mutation"): Promise<T> {
    return this.client.trpc<T>(this.grantId, path, input, type);
  }
  issue(input: { kind: "action" | "schedule"; oneonActionId?: string; scope: string[]; absoluteExpiresAt: string }): Promise<{ grantId: string }> {
    return this.client.issue(this.grantId, input);
  }
}

const tokenKey = (grantId: string, oneonActionId?: string) => `${grantId}:${oneonActionId ?? ""}`;

function parseSnapshot(s: Partial<MembershipSnapshot> | null | undefined): MembershipSnapshot | null {
  if (
    !s ||
    typeof s.userId !== "string" ||
    typeof s.role !== "string" ||
    typeof s.tokenVersion !== "number" ||
    typeof s.tenantStatus !== "string" ||
    !Array.isArray(s.permissions) ||
    !Array.isArray(s.locationIds)
  ) {
    return null;
  }
  return { userId: s.userId, role: s.role, permissions: s.permissions, locationIds: s.locationIds, tokenVersion: s.tokenVersion, tenantStatus: s.tenantStatus };
}

function parseTriple(g: unknown): GrantTriple | null {
  const t = g as Partial<GrantTriple> | null;
  return t && typeof t.id === "string" && typeof t.value === "string" && typeof t.generation === "number"
    ? { id: t.id, value: t.value, generation: t.generation }
    : null;
}

function parseTokenResponse(body: unknown): TokenResponse | null {
  const b = body as Partial<TokenResponse> | null;
  if (!b || typeof b.accessToken !== "string" || typeof b.accessTokenExpiresAt !== "string" || Number.isNaN(Date.parse(b.accessTokenExpiresAt))) return null;
  const grant = parseTriple(b.grant);
  const snapshot = parseSnapshot(b.snapshot);
  if (!grant || !snapshot) return null;
  const issued = b.issued === undefined ? undefined : parseTriple(b.issued);
  if (issued === null) return null;
  return { accessToken: b.accessToken, accessTokenExpiresAt: b.accessTokenExpiresAt, grant, snapshot, issued };
}

/** Builds the client with its grant store and registration repository, so callers never import the grant store (I4). */
export function createImpressoRxClient(opts: {
  control: ControlDb;
  grantMasterKeyB64: string;
  enrolment: Pick<EnrolmentService, "oneonSigningKeys">;
  onSnapshot: (membershipId: string, snapshot: MembershipSnapshot) => void;
  fetchImpl?: FetchLike;
  logger?: Logger;
  clock?: () => Date;
}): ImpressoRxClient {
  return new ImpressoRxClient({
    registrations: new TenantRegistrationRepository(opts.control),
    grants: new GrantStore(opts.control, opts.grantMasterKeyB64, opts.clock),
    enrolment: opts.enrolment,
    onSnapshot: opts.onSnapshot,
    fetchImpl: opts.fetchImpl,
    logger: opts.logger,
    clock: opts.clock,
  });
}
