import { randomUUID } from "node:crypto";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { openSecret, sealSecret } from "../crypto/envelope.js";
import { generateEd25519Key, parsePublicJwk, signJws, verifyJws, type JWK, type VerifiedJws } from "../crypto/jws.js";
import type { TenantRegistration, TenantRegistrationRepository } from "../database/control/tenant-registration-repository.js";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Any failure talking to, or verifying, the deployment. Carries no remote detail on purpose. */
export class EnrolmentFailedError extends Error {
  constructor(message = "Enrolment failed") {
    super(message);
    this.name = "EnrolmentFailedError";
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
const VERIFY_REFRESH_MIN_INTERVAL_MS = 60_000;
/** At most this many Oneon keys are tried when the deployment refuses the newest. */
const MAX_KEY_ATTEMPTS = 3;

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
    const master = this.master();
    const origin = new URL(input.origin).origin;
    const issuer = `impressorx:${input.tenantSlug}`;
    const key = await generateEd25519Key();
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
    if (claims.nonce !== nonce || claims.tenantSlug !== input.tenantSlug || claims.deploymentKeyId !== verified.kid || !deploymentJwk) {
      throw new EnrolmentFailedError();
    }

    return this.deps.repo.create(
      {
        tenantSlug: input.tenantSlug,
        displayName: input.displayName?.trim() || input.tenantSlug,
        origin,
        deploymentKeyId: verified.kid,
        deploymentPublicKeyJwk: deploymentJwk,
        oneonKeyId: key.keyId,
        oneonPublicKeyJwk: key.publicKeyJwk,
        oneonPrivateKeySealed: sealSecret(JSON.stringify(key.privateKeyJwk), master),
        enrolledBy: input.enrolledBy,
      },
      input.inTransaction,
    );
  }

  /** Current Oneon signing key (newest unretired), decrypted on demand. */
  async oneonSigningKey(registrationId: string): Promise<{ keyId: string; privateKeyJwk: JWK }> {
    const [first] = this.openOneonKeys(registrationId);
    if (!first) throw new EnrolmentFailedError("No signing key");
    return first;
  }

  /**
   * Unretired Oneon keys, newest first. After an unclear rotation the newest key may not be known to the deployment
   * yet, so a request refused with the newest key should be retried with the next one (as rotateOneonKey does).
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
   * - a definite refusal (4xx): the new key is deleted again;
   * - anything unclear (network, timeout, 5xx): both keys are kept, and the next request falls back to the older key
   *   when the deployment refuses the newest.
   */
  async rotateOneonKey(registrationId: string, actor: string | null = null): Promise<void> {
    const master = this.master();
    const registration = this.activeRegistration(registrationId);
    const next = await generateEd25519Key();
    this.deps.repo.addPendingOneonKey(registrationId, next.keyId, next.publicKeyJwk, sealSecret(JSON.stringify(next.privateKeyJwk), master));

    // Newest first. The new key is unknown to the deployment, so its request is refused and the next key is tried.
    const candidates = this.openOneonKeys(registrationId).slice(0, MAX_KEY_ATTEMPTS);
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
      if (res.status >= 500) {
        ambiguous = true;
        break;
      }
    }
    if (!ambiguous) this.deps.repo.deleteOneonKey(registrationId, next.keyId);
    throw new EnrolmentFailedError();
  }

  /** Fetches the key list of a deployment, verifies it with a key already known, and stores it. */
  async refreshDeploymentKeys(registrationId: string): Promise<void> {
    const registration = this.activeRegistration(registrationId);
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
    options: { audience: string; consumeJti?: (jti: string, expiresAt: string) => boolean },
  ): Promise<VerifiedJws> {
    const registration = this.activeRegistration(registrationId);
    const attempt = () => {
      const keys = this.deps.repo.deploymentKeys(registrationId);
      return verifyJws(token, {
        resolveKey: (kid) => keys.find((k) => k.keyId === kid)?.publicKeyJwk ?? null,
        issuer: `impressorx:${registration.tenantSlug}`,
        audience: options.audience,
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
    } catch {
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
