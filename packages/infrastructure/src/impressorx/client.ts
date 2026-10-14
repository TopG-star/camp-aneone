import { randomUUID } from "node:crypto";
import type { Logger } from "@oneon/domain";
import { signJws } from "../crypto/jws.js";
import { GrantInactiveError, GrantStore, idleExpiryFor, type GrantRecord, type InsertGrant, type PendingOp } from "../database/control/grant-store.js";
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

/**
 * ImpressoRx itself answered 401, which is the contract's only refusal (an unknown or revoked grant, a deactivated user,
 * a disabled client). Every other ImpressoRxRefusedError is not ImpressoRx's word: a local state (inactive registration,
 * grant revoked or expired here) or an unexpected status (404, 400, 3xx). Callers that must tell them apart test for this class.
 */
export class ImpressoRxUnauthorizedError extends ImpressoRxRefusedError {
  /**
   * True when every attempt of the signed request was answered 401, with no timeout, network failure or 5xx before it, so none of
   * them can have been applied. A 401 after an ambiguous attempt says nothing about whether the request was applied.
   */
  constructor(
    message = "ImpressoRx answered 401",
    readonly unambiguous = false,
  ) {
    super(message, 401);
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
  /** `oneonActionId` names the Oneon action the call belongs to, so ImpressoRx can attribute the write; an action grant already carries it. */
  trpc<T>(path: string, input: unknown, type: "query" | "mutation", opts?: { oneonActionId?: string }): Promise<T>;
}

/** A grant as its owner sees it in Settings → Connections: metadata only, never the value. */
export interface GrantSummary {
  id: string;
  tenantRegistrationId: string;
  kind: GrantRecord["kind"];
  scope: string[];
  /** `expired` while the record still says active but its idle or absolute expiry has passed. */
  status: "active" | "revoked" | "expired";
  sessionId: string | null;
  actionId: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  /** The sooner of the idle and the absolute expiry: when the grant ends if nobody uses it. */
  expiresAt: string;
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
    const absoluteExpiresAt = new Date(now + ATTENDED_ABSOLUTE_MS).toISOString();
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
      idleExpiresAt: idleExpiryFor("attended", now, absoluteExpiresAt),
      absoluteExpiresAt,
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

  /**
   * Attended calls for the grant opened for exactly this session, identity and membership; null when there is none or it
   * is past its local idle or absolute expiry. Use this, not forSession, wherever the session names a membership.
   */
  forBoundSession(sessionId: string, identityId: string, membershipId: string): SessionCalls | null {
    const grant = this.usableBoundGrant(sessionId, identityId, membershipId);
    return grant ? new Handle(this, grant.id) : null;
  }

  /** True while this session holds a usable attended grant (active and unexpired) opened for exactly this identity and membership. */
  hasAttendedGrant(sessionId: string, identityId: string, membershipId: string): boolean {
    return this.usableBoundGrant(sessionId, identityId, membershipId) !== null;
  }

  /**
   * Revokes every grant of the registration locally (nothing is sent) and forgets their cached tokens. Used by re-enrolment: the
   * deployment's Remove already ended them there, and none may outlive the keys it was issued under.
   */
  revokeForRegistration(registrationId: string, reason: string): void {
    for (const id of this.deps.grants.revokeForRegistration(registrationId, reason)) this.dropTokens(id);
  }

  /** Revokes every grant of the membership locally (nothing is sent), e.g. after ImpressoRx refuses it. */
  revokeForMembership(membershipId: string, reason: string): void {
    for (const id of this.deps.grants.revokeForMembership(membershipId, reason)) this.dropTokens(id);
  }

  /**
   * For grants another module revoked in SQL (a merge or an unlink, in its own control transaction): forget their cached
   * access tokens now, so none is used for the minutes it still has to live, then tell the deployment, best effort. A failure
   * to reach ImpressoRx is logged at warn and never thrown; the grants are already unusable here.
   */
  async releaseGrants(grantIds: string[]): Promise<void> {
    for (const id of grantIds) this.dropTokens(id);
    for (const id of grantIds) await this.revokeRemotely(id);
  }

  /** The identity's grants, oldest first, as metadata (Settings → Connections). Another identity's grants are never in it. */
  listGrantsFor(identityId: string): GrantSummary[] {
    return this.deps.grants.listForIdentity(identityId).map((g) => ({
      id: g.id,
      tenantRegistrationId: g.tenantRegistrationId,
      kind: g.kind,
      scope: g.scope,
      status: g.status === "active" && this.pastExpiry(g) ? "expired" : g.status,
      sessionId: g.sessionId,
      actionId: g.actionId,
      createdAt: g.createdAt,
      lastUsedAt: g.lastUsedAt,
      expiresAt: g.idleExpiresAt !== null && Date.parse(g.idleExpiresAt) < Date.parse(g.absoluteExpiresAt) ? g.idleExpiresAt : g.absoluteExpiresAt,
    }));
  }

  /**
   * The person gives up one of their own grants. It is revoked here first and its cached tokens forgotten, whatever happens next, so a
   * revoke never depends on ImpressoRx being up; then ImpressoRx is told. `remote` says whether it confirmed. Null when the grant is
   * not this identity's or does not exist (the caller cannot tell which). Revoking again is fine: nothing changes here, and the
   * deployment is asked again, so an earlier `unreachable` can be finished (ImpressoRx answers 204 whether or not the grant was live).
   */
  async revokeGrantFor(identityId: string, grantId: string): Promise<{ remote: "revoked" | "unreachable" } | null> {
    const record = this.deps.grants.find(grantId);
    if (!record || record.identityId !== identityId) return null;
    this.deps.grants.revoke(grantId, "revoked_by_person");
    this.dropTokens(grantId);
    return { remote: await this.revokeRemotely(grantId) };
  }

  /** Unattended calls (actions, schedules). */
  forGrant(grantId: string): GrantCalls {
    return new Handle(this, grantId);
  }

  /** Unattended calls through the active grant issued for this one action; null when it has none. */
  forActionGrant(actionId: string): GrantCalls | null {
    const grantId = this.deps.grants.findActionGrant(actionId);
    return grantId ? new Handle(this, grantId) : null;
  }

  /** True when the action has ever had a grant stored here, active or not. */
  hadActionGrant(actionId: string): boolean {
    return this.deps.grants.hadActionGrant(actionId);
  }

  /**
   * The action is over: its grant is revoked here first, so it is never used again, then at ImpressoRx on a best-effort basis
   * (releaseGrants also drops its cached tokens and logs a failure at warn). Never throws for an unreachable deployment; an action with
   * no active grant sends nothing. The end is remembered either way: a grant stored for this action later (an issue still in flight, or
   * one a later exchange replays) is stored revoked, and revoked at ImpressoRx too.
   */
  async revokeActionGrant(actionId: string, reason: string): Promise<void> {
    const grantId = this.deps.grants.endAction(actionId, reason);
    if (grantId) await this.releaseGrants([grantId]);
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
  async trpc<T>(grantId: string, path: string, input: unknown, type: "query" | "mutation", oneonActionId?: string): Promise<T> {
    const record = this.activeGrant(grantId);
    const registration = this.registration(record.tenantRegistrationId);
    const token = await this.accessToken(grantId, oneonActionId);
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
    begin: { value: string; requestId: string; pendingSince: string; pendingOp: PendingOp; reused: boolean },
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
    let res: TokenResponse;
    try {
      res = await this.postToken(registration, claims, true, Date.parse(begin.pendingSince));
    } catch (error) {
      // A request refused on every attempt (for example an issue while unattended access is off) applied nothing. The stored request must
      // not be replayed, and refused again, by the next exchange of this grant, which is still good for what it is allowed to do.
      // That holds only for a request that is new here and was refused by every attempt with no timeout or 5xx before it. A replayed
      // request may have been applied already, and ImpressoRx also answers 401 without revoking anything while the pharmacy is not
      // active: dropping it would leave Oneon holding the value from before the rotation, which ImpressoRx counts as theft.
      if (error instanceof ImpressoRxUnauthorizedError && error.unambiguous && !begin.reused) {
        this.deps.grants.abandonExchange(record.id, begin.requestId);
      }
      throw error;
    }

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
        idleExpiresAt: idleExpiryFor(op.kind, now, op.absoluteExpiresAt),
        absoluteExpiresAt: op.absoluteExpiresAt,
      };
    }
    // The rotation is always completed, even when the reply turns out to be unusable.
    const issuedForEndedAction = this.complete(record.id, begin.requestId, res, issued);
    this.cacheToken(record.id, op.grantType === "grant" ? op.oneonActionId : undefined, res);
    this.deps.onSnapshot(record.membershipId, res.snapshot);
    // Its action had already reached a final status: it was stored revoked, and ImpressoRx is told (best effort, never thrown).
    if (issuedForEndedAction && issued) await this.releaseGrants([issued.id]);
    if (op.grantType === "issue" && !issued) throw new ImpressoRxUnreachableError("Reply carries no issued grant");
    return { accessToken: res.accessToken, issuedGrantId: issued?.id };
  }

  private dropTokens(grantId: string): void {
    for (const key of [...this.tokens.keys()]) if (key.startsWith(`${grantId}:`)) this.tokens.delete(key);
  }

  /**
   * Tells the grant's deployment to revoke it (one signed attempt). `unreachable` when it did not confirm: the deployment could not be
   * asked (its registration is not active, or the grant is unknown here) or did not answer; a failure is logged at warn, never thrown.
   */
  private async revokeRemotely(grantId: string): Promise<"revoked" | "unreachable"> {
    const record = this.deps.grants.find(grantId);
    const registration = record ? this.deps.registrations.findById(record.tenantRegistrationId) : null;
    if (!record || !registration || registration.status !== "active") return "unreachable";
    try {
      await this.signedPost(registration, "/api/oneon/revoke", { grantId }, false);
      return "revoked";
    } catch (error) {
      this.deps.logger?.warn("Revoking a grant at ImpressoRx failed", { error: error instanceof Error ? error.name : "unknown" });
      return "unreachable";
    }
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

  private complete(grantId: string, requestId: string, res: TokenResponse, issued?: InsertGrant): boolean {
    try {
      return this.deps.grants.completeExchange(grantId, requestId, res.grant.value, res.grant.generation, issued);
    } catch (error) {
      if (error instanceof GrantInactiveError) throw new ImpressoRxRefusedError("Grant is not active");
      throw error;
    }
  }

  private activeGrant(grantId: string): GrantRecord {
    const record = this.deps.grants.find(grantId);
    if (!record || record.status !== "active") throw new ImpressoRxRefusedError("Grant is not active");
    if (this.pastExpiry(record)) throw new ImpressoRxRefusedError("Grant has expired");
    return record;
  }

  private pastExpiry(record: GrantRecord): boolean {
    const now = this.clock().getTime();
    return Date.parse(record.absoluteExpiresAt) <= now || (record.idleExpiresAt !== null && Date.parse(record.idleExpiresAt) <= now);
  }

  private usableBoundGrant(sessionId: string, identityId: string, membershipId: string): GrantRecord | null {
    const grant = this.deps.grants.findAttendedForSessionBound(sessionId, identityId, membershipId);
    return grant && !this.pastExpiry(grant) ? grant : null;
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
    let unauthorized = false;
    // An attempt that got no answer, or a 5xx or 429, may have been applied before the connection failed.
    let ambiguous = false;
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
        if (status === 401) {
          unauthorized = true;
          break;
        }
        if (status !== null && status < 500 && status !== 429) throw new ImpressoRxRefusedError(`ImpressoRx answered ${status}`, status);
        ambiguous = true;
        const elapsed = this.clock().getTime() - started;
        if (!retry || attempt >= MAX_ATTEMPTS || elapsed + RETRY_DELAY_MS * attempt + RETRY_MARGIN_MS >= RETRY_WINDOW_MS) {
          this.deps.logger?.warn("ImpressoRx unreachable", { path, status });
          throw new ImpressoRxUnreachableError();
        }
        await this.sleep(RETRY_DELAY_MS * attempt);
      }
    }
    this.deps.logger?.warn("ImpressoRx refused a signed request", { path });
    throw unauthorized ? new ImpressoRxUnauthorizedError("ImpressoRx refused the request", !ambiguous) : new ImpressoRxRefusedError();
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
    if (status === 401) throw new ImpressoRxUnauthorizedError();
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
  trpc<T>(path: string, input: unknown, type: "query" | "mutation", opts?: { oneonActionId?: string }): Promise<T> {
    return this.client.trpc<T>(this.grantId, path, input, type, opts?.oneonActionId);
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
  /** Pause between retries of a transient failure; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
}): ImpressoRxClient {
  return new ImpressoRxClient({
    registrations: new TenantRegistrationRepository(opts.control),
    grants: new GrantStore(opts.control, opts.grantMasterKeyB64, opts.clock),
    enrolment: opts.enrolment,
    onSnapshot: opts.onSnapshot,
    fetchImpl: opts.fetchImpl,
    logger: opts.logger,
    clock: opts.clock,
    sleep: opts.sleep,
  });
}
