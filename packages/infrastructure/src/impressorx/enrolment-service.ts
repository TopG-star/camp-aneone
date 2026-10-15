import { randomUUID } from "node:crypto";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { openSecret, sealSecret, type SealedSecret } from "../crypto/envelope.js";
import { JwsError, generateEd25519Key, parsePublicJwk, signJws, verifyJws, type JWK, type VerifiedJws } from "../crypto/jws.js";
import {
  ReenrolmentConflictError,
  type TenantRegistration,
  type TenantRegistrationRepository,
} from "../database/control/tenant-registration-repository.js";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Any failure talking to, or verifying, the deployment. Carries no remote detail on purpose. */
export class EnrolmentFailedError extends Error {
  /**
   * Set only when the signature was valid: the message was too old or already used, or (enrolment) the deployment's signed reply
   * named another tenant slug than the one entered (`slug_mismatch`), named no ImpressoRx tenant id (`impressorx_tenant_id_missing`, an
   * ImpressoRx release from before it was sent), named another one than the registration holds (`impressorx_tenant_mismatch`, the pharmacy
   * was set up again or its database replaced), or named one another registration already holds (`impressorx_tenant_already_enrolled`).
   */
  constructor(
    message = "Enrolment failed",
    readonly reason?: "expired" | "replayed" | "slug_mismatch" | "impressorx_tenant_id_missing" | "impressorx_tenant_mismatch" | "impressorx_tenant_already_enrolled",
  ) {
    super(message);
    this.name = "EnrolmentFailedError";
  }
}

/**
 * The deployment accepted the code, so ImpressoRx now shows Oneon as connected, but Oneon stored nothing (review I2):
 * - `registration_changed`: the registration is no longer suspended (another operation moved it while the deployment answered);
 * - `slug_taken` / `impressorx_tenant_taken`: another registration took the slug or the ImpressoRx tenant id meanwhile;
 * - `not_stored`: storing failed for another reason (for example the tenant file could not be created). `cause` holds the error.
 */
export class EnrolmentNotStoredError extends Error {
  constructor(
    readonly reason: "registration_changed" | "slug_taken" | "impressorx_tenant_taken" | "not_stored",
    options?: { cause?: unknown },
  ) {
    super(`Enrolment not stored: ${reason}`, options);
    this.name = "EnrolmentNotStoredError";
  }
}

/** A re-enrolment refused before anything was sent: the code is not spent. */
export class ReenrolmentRefusedError extends Error {
  constructor(readonly reason: "not_suspended" | "origin_mismatch") {
    super(reason === "not_suspended" ? "Only a suspended registration can be re-enrolled" : "Re-enrolment must use the registration's pinned origin");
    this.name = "ReenrolmentRefusedError";
  }
}

/** ONEON_SIGNING_KEY_MASTER_KEY is not set, so no private key can be sealed or opened. */
export class SigningKeyNotConfiguredError extends Error {
  constructor() {
    super("ONEON_SIGNING_KEY_MASTER_KEY is not configured");
    this.name = "SigningKeyNotConfiguredError";
  }
}

export interface EnrolmentServiceDeps {
  repo: TenantRegistrationRepository;
  /** The agent-server's PUBLIC_URL. Sent to the deployment as `oneonOrigin`. */
  oneonOrigin: string;
  masterKeyB64: string | undefined;
  fetchImpl?: FetchLike;
  clock?: () => Date;
}

/** Re-enrolment of a suspended registration: the same two-sided proof with a fresh code, at the registration's pinned origin. */
export interface ReenrolInput {
  registrationId: string;
  /** Must be the registration's pinned origin. */
  origin: string;
  /** Named so log redaction (key `enrolmentCode`) covers it. */
  enrolmentCode: string;
  reenrolledBy: string;
  /** Runs inside the key replacement's control-database transaction (grant revocation); if it throws, nothing changes. */
  inTransaction?: () => void;
}

export interface EnrolInput {
  /** https origin of the deployment. */
  origin: string;
  tenantSlug: string;
  /** Named so log redaction (key `enrolmentCode`) covers it. */
  enrolmentCode: string;
  displayName?: string;
  enrolledBy: string;
  /** Runs inside the same control-database transaction as the registration; if it throws, nothing is stored. */
  inTransaction?: (registration: TenantRegistration) => void;
}

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Runs the write that follows a successful proof. The code is spent by then, so every failure becomes a typed error the route can
 * explain (review I2): a refusal stays an EnrolmentFailedError, a race or a constraint violation is EnrolmentNotStoredError
 * (`registration_changed`, `slug_taken`, `impressorx_tenant_taken`), and anything else is EnrolmentNotStoredError `not_stored`.
 */
function storeAfterProof<T>(write: () => T): T {
  try {
    return write();
  } catch (error) {
    if (error instanceof EnrolmentFailedError || error instanceof EnrolmentNotStoredError) throw error;
    if (error instanceof ReenrolmentConflictError) {
      if (error.reason === "impressorx_tenant_mismatch") throw new EnrolmentFailedError("Enrolment failed", "impressorx_tenant_mismatch");
      throw new EnrolmentNotStoredError("registration_changed", { cause: error });
    }
    // better-sqlite3 names the column: "UNIQUE constraint failed: tenant_registrations.tenant_slug".
    if ((error as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE") {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("tenant_registrations.tenant_slug")) throw new EnrolmentNotStoredError("slug_taken", { cause: error });
      if (message.includes("tenant_registrations.impressorx_tenant_id")) throw new EnrolmentNotStoredError("impressorx_tenant_taken", { cause: error });
    }
    throw new EnrolmentNotStoredError("not_stored", { cause: error });
  }
}
const VERIFY_REFRESH_MIN_INTERVAL_MS = 60_000;

export class EnrolmentService {
  private readonly fetchImpl: FetchLike;
  private readonly clock: () => Date;
  private readonly lastVerifyRefresh = new Map<string, number>();

  constructor(private readonly deps: EnrolmentServiceDeps) {
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
    this.clock = deps.clock ?? (() => new Date());
  }

  get configured(): boolean {
    return Boolean(this.deps.masterKeyB64);
  }

  async enrol(input: EnrolInput): Promise<TenantRegistration> {
    const proved = await this.prove(input.origin, input.tenantSlug, input.enrolmentCode);
    this.refuseIfHeldByAnother(proved.impressorxTenantId);
    return storeAfterProof(() =>
      this.deps.repo.create(
        {
          tenantSlug: input.tenantSlug,
          displayName: input.displayName?.trim() || input.tenantSlug,
          origin: proved.origin,
          ...proved.keys,
          impressorxTenantId: proved.impressorxTenantId,
          enrolledBy: input.enrolledBy,
        },
        input.inTransaction,
      ),
    );
  }

  /**
   * Re-enrols a suspended registration (ruling): its pinned origin and slug only, proved like a first enrolment with a fresh code;
   * every old key is retired at once and the proved keys replace them; the registration becomes active. Refused (nothing sent)
   * when the registration is not suspended or the origin differs. Refused after the proof (the code is spent, nothing stored) when
   * the deployment names another ImpressoRx tenant id than the registration holds: the slug is only a name, and a pharmacy set up
   * again under it must not inherit this registration. Every registration holds its id (owner decision D1), so the id always decides.
   */
  async reenrol(input: ReenrolInput): Promise<TenantRegistration> {
    const registration = this.deps.repo.findById(input.registrationId);
    if (!registration || registration.status !== "suspended_by_operator") throw new ReenrolmentRefusedError("not_suspended");
    if (new URL(input.origin).origin !== registration.origin) throw new ReenrolmentRefusedError("origin_mismatch");
    const proved = await this.prove(registration.origin, registration.tenantSlug, input.enrolmentCode);
    if (proved.impressorxTenantId !== registration.impressorxTenantId) {
      throw new EnrolmentFailedError("Enrolment failed", "impressorx_tenant_mismatch");
    }
    return storeAfterProof(() =>
      this.deps.repo.replaceKeysOnReenrolment(registration.id, proved.keys, proved.impressorxTenantId, input.reenrolledBy, input.inTransaction),
    );
  }

  /** One pharmacy, one registration: a copy of an enrolled pharmacy's database carries its Tenant.id under any slug. */
  private refuseIfHeldByAnother(impressorxTenantId: string): void {
    if (this.deps.repo.findByImpressorxTenantId(impressorxTenantId)) throw new EnrolmentFailedError("Enrolment failed", "impressorx_tenant_already_enrolled");
  }

  /** The two-sided enrolment proof (spec §5.1-5.2, 5.6): spends the code at the deployment and returns the keys both sides now hold. */
  private async prove(
    originInput: string,
    tenantSlug: string,
    enrolmentCode: string,
  ): Promise<{
    origin: string;
    impressorxTenantId: string;
    keys: { deploymentKeyId: string; deploymentPublicKeyJwk: JWK; oneonKeyId: string; oneonPublicKeyJwk: JWK; oneonPrivateKeySealed: SealedSecret };
  }> {
    const input = { tenantSlug, enrolmentCode };
    const master = this.master();
    const origin = new URL(originInput).origin;
    const issuer = `impressorx:${input.tenantSlug}`;
    const key = await generateEd25519Key();
    // Sealed before the request: a master key that cannot seal must fail before the code is spent.
    const oneonPrivateKeySealed = sealSecret(JSON.stringify(key.privateKeyJwk), master);
    const nonce = randomUUID();

    // Every JWK travels as a JSON string.
    const request = await signJws({
      privateKeyJwk: key.privateKeyJwk,
      kid: key.keyId,
      iss: "oneon",
      aud: issuer,
      now: this.clock(),
      claims: {
        code: input.enrolmentCode,
        oneonPublicKeyJwk: JSON.stringify(key.publicKeyJwk),
        oneonKeyId: key.keyId,
        oneonOrigin: this.deps.oneonOrigin,
        nonce,
      },
    });
    const body = await this.post(origin, "/api/oneon/enrol", { request });
    if (body.status !== 200) throw new EnrolmentFailedError();
    const reply = await this.readResponse(body);

    // The reply is verified with the key it announces; the single-use code is what ties it to the real deployment.
    let verified: VerifiedJws;
    try {
      const claimed = decodeJwt(reply) as { deploymentKeyId?: unknown; deploymentPublicKeyJwk?: unknown };
      const announced = parsePublicJwk(claimed.deploymentPublicKeyJwk);
      verified = await verifyJws(reply, {
        resolveKey: (kid) => (kid === claimed.deploymentKeyId ? announced : null),
        issuer,
        audience: "oneon",
        now: this.clock(),
      });
    } catch {
      throw new EnrolmentFailedError();
    }
    const claims = verified.payload;
    const deploymentJwk = parsePublicJwk(claims.deploymentPublicKeyJwk);
    if (claims.nonce !== nonce || claims.deploymentKeyId !== verified.kid || !deploymentJwk) throw new EnrolmentFailedError();
    // The reply is verified: the deployment itself says which tenant it is.
    if (claims.tenantSlug !== input.tenantSlug) throw new EnrolmentFailedError("Enrolment failed", "slug_mismatch");
    // ImpressoRx's Tenant.id: the pharmacy's permanent identity, which the slug is not.
    const impressorxTenantId = claims.impressorxTenantId;
    if (typeof impressorxTenantId !== "string" || impressorxTenantId === "") {
      throw new EnrolmentFailedError("Enrolment failed", "impressorx_tenant_id_missing");
    }

    return {
      origin,
      impressorxTenantId,
      keys: {
        deploymentKeyId: verified.kid,
        deploymentPublicKeyJwk: deploymentJwk,
        oneonKeyId: key.keyId,
        oneonPublicKeyJwk: key.publicKeyJwk,
        oneonPrivateKeySealed,
      },
    };
  }

  /** Current Oneon signing key (newest unretired), decrypted on demand. */
  async oneonSigningKey(registrationId: string): Promise<{ keyId: string; privateKeyJwk: JWK }> {
    const [first] = this.openOneonKeys(registrationId);
    if (!first) throw new EnrolmentFailedError("No signing key");
    return first;
  }

  /**
   * Unretired Oneon keys, newest first. After an unclear rotation the newest key may not be known to the deployment
   * yet, so a caller whose request is refused (401) with one key should try the next, down to the oldest.
   */
  oneonSigningKeys(registrationId: string): Array<{ keyId: string; privateKeyJwk: JWK }> {
    return this.openOneonKeys(registrationId);
  }

  private openOneonKeys(registrationId: string): Array<{ keyId: string; privateKeyJwk: JWK }> {
    const master = this.master();
    return this.deps.repo
      .unretiredOneonKeys(registrationId)
      .map((k) => ({ keyId: k.keyId, privateKeyJwk: JSON.parse(openSecret(k.sealedPrivateKey, master)) as JWK }));
  }

  /**
   * Registers a new Oneon key at the deployment. The new key is stored (sealed) BEFORE the request, so a lost answer
   * cannot leave the deployment holding a key Oneon never recorded:
   * - 204: the other keys retire in 7 days;
   * - 401 (the only definite refusal): the new key is deleted again;
   * - anything else (429, 403, 5xx, network, timeout, ...): the key is kept, because the change may have landed.
   * The announced key never signs its own announcement; every other unretired key is tried, newest first, so a key the
   *   deployment never received cannot lock rotation.
   */
  async rotateOneonKey(registrationId: string, actor: string | null = null): Promise<void> {
    const master = this.master();
    const registration = this.activeRegistration(registrationId);
    const next = await generateEd25519Key();
    this.deps.repo.addPendingOneonKey(registrationId, next.keyId, next.publicKeyJwk, sealSecret(JSON.stringify(next.privateKeyJwk), master));

    const candidates = this.openOneonKeys(registrationId).filter((k) => k.keyId !== next.keyId);
    let ambiguous = false;
    for (const signer of candidates) {
      const request = await signJws({
        privateKeyJwk: signer.privateKeyJwk,
        kid: signer.keyId,
        iss: "oneon",
        aud: `impressorx:${registration.tenantSlug}`,
        now: this.clock(),
        claims: { newKeyId: next.keyId, newPublicKeyJwk: JSON.stringify(next.publicKeyJwk) },
      });
      let res: Response;
      try {
        res = await this.post(registration.origin, "/api/oneon/keys", { request });
      } catch {
        ambiguous = true;
        break;
      }
      if (res.status === 204) {
        this.deps.repo.retireOtherOneonKeys(registrationId, next.keyId, actor);
        return;
      }
      if (res.status !== 401) {
        ambiguous = true;
        break;
      }
    }
    if (!ambiguous) this.deps.repo.deleteOneonKey(registrationId, next.keyId);
    throw new EnrolmentFailedError();
  }

  /** Fetches the key list of a deployment, verifies it with a key already known, and stores it. Active registrations only. */
  async refreshDeploymentKeys(registrationId: string): Promise<void> {
    await this.refreshKeys(this.activeRegistration(registrationId));
  }

  /**
   * The one refresh a suspended registration gets (owner decision D5): Resume calls it, while the registration is still
   * `suspended_by_operator`, so that a key the deployment rotated during the suspension is known before the pharmacy is served again.
   * Verified with the keys already stored, like every refresh. Every other refresh still requires `active`.
   */
  async refreshDeploymentKeysBeforeResume(registrationId: string): Promise<void> {
    const registration = this.deps.repo.findById(registrationId);
    if (!registration || registration.status !== "suspended_by_operator") throw new EnrolmentFailedError("Unknown registration");
    await this.refreshKeys(registration);
  }

  private async refreshKeys(registration: TenantRegistration): Promise<void> {
    const registrationId = registration.id;
    const known = this.deps.repo.deploymentKeys(registrationId);
    const res = await this.fetchImpl(`${registration.origin}/api/oneon/keys`, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }).catch(() => {
      throw new EnrolmentFailedError();
    });
    if (res.status !== 200) throw new EnrolmentFailedError();
    const reply = await this.readResponse(res);

    let payload: Record<string, unknown>;
    try {
      ({ payload } = await verifyJws(reply, {
        resolveKey: (kid) => known.find((k) => k.keyId === kid)?.publicKeyJwk ?? null,
        issuer: `impressorx:${registration.tenantSlug}`,
        audience: "oneon",
        now: this.clock(),
      }));
    } catch {
      throw new EnrolmentFailedError();
    }
    const list = payload.keys;
    if (!Array.isArray(list) || list.length === 0) throw new EnrolmentFailedError();
    const keys = list.map((entry) => {
      const k = entry as { keyId?: unknown; publicKeyJwk?: unknown; retiresAt?: unknown };
      const jwk = parsePublicJwk(k.publicKeyJwk);
      if (typeof k.keyId !== "string" || !jwk) throw new EnrolmentFailedError();
      return { keyId: k.keyId, publicKeyJwk: jwk, retiresAt: typeof k.retiresAt === "string" ? k.retiresAt : null };
    });
    this.deps.repo.replaceDeploymentKeys(registrationId, keys);
  }

  /**
   * Verifies a message from a deployment with its known keys. Only an unknown `kid` triggers a key-list refresh (at most
   * once a minute per registration) before the check is repeated; a bad signature under a known key never reaches the
   * network. Every failure is an EnrolmentFailedError.
   */
  async verifyFromDeployment(
    registrationId: string,
    token: string,
    options: { audience: string; maxTtlSeconds?: number; consumeJti?: (jti: string, expiresAt: string) => boolean },
  ): Promise<VerifiedJws> {
    const registration = this.activeRegistration(registrationId);
    const attempt = () => {
      const keys = this.deps.repo.deploymentKeys(registrationId);
      return verifyJws(token, {
        resolveKey: (kid) => keys.find((k) => k.keyId === kid)?.publicKeyJwk ?? null,
        issuer: `impressorx:${registration.tenantSlug}`,
        audience: options.audience,
        maxTtlSeconds: options.maxTtlSeconds,
        now: this.clock(),
        consumeJti: options.consumeJti,
      });
    };
    let kid: unknown;
    try {
      kid = decodeProtectedHeader(token).kid;
    } catch {
      throw new EnrolmentFailedError();
    }
    const known = this.deps.repo.deploymentKeys(registrationId).some((k) => k.keyId === kid);
    try {
      if (!known) {
        const now = this.clock().getTime();
        const last = this.lastVerifyRefresh.get(registrationId);
        if (last === undefined || now - last >= VERIFY_REFRESH_MIN_INTERVAL_MS) {
          this.lastVerifyRefresh.set(registrationId, now);
          await this.refreshDeploymentKeys(registrationId);
        }
      }
      return await attempt();
    } catch (error) {
      // verifyJws raises these only after the signature has verified, so they say nothing about unauthenticated callers.
      if (error instanceof JwsError && (error.message === "expired" || error.message === "replayed")) {
        throw new EnrolmentFailedError("Enrolment failed", error.message);
      }
      throw new EnrolmentFailedError();
    }
  }

  /** Nightly job: refresh every active registration; one failing deployment does not stop the others. */
  async refreshAll(onError: (registrationId: string) => void): Promise<void> {
    for (const registration of this.deps.repo.listActive()) {
      try {
        await this.refreshDeploymentKeys(registration.id);
      } catch {
        onError(registration.id);
      }
    }
  }

  private master(): string {
    if (!this.deps.masterKeyB64) throw new SigningKeyNotConfiguredError();
    return this.deps.masterKeyB64;
  }

  private activeRegistration(id: string): TenantRegistration {
    const registration = this.deps.repo.findById(id);
    if (!registration || registration.status !== "active") throw new EnrolmentFailedError("Unknown registration");
    return registration;
  }

  private async post(origin: string, path: string, body: object): Promise<Response> {
    try {
      return await this.fetchImpl(`${origin}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new EnrolmentFailedError();
    }
  }

  private async readResponse(res: Response): Promise<string> {
    try {
      const body = (await res.json()) as { response?: unknown };
      if (typeof body.response !== "string") throw new Error("no response");
      return body.response;
    } catch {
      throw new EnrolmentFailedError();
    }
  }
}
