import { randomUUID } from "node:crypto";
import { decodeJwt } from "jose";
import { openSecret, sealSecret } from "../crypto/envelope.js";
import { generateEd25519Key, signJws, verifyJws, type JWK, type VerifiedJws } from "../crypto/jws.js";
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
  code: string;
  displayName?: string;
  enrolledBy: string;
}

const REQUEST_TIMEOUT_MS = 10_000;

export class EnrolmentService {
  private readonly fetchImpl: FetchLike;
  private readonly clock: () => Date;

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

    const request = await signJws({
      privateKeyJwk: key.privateKeyJwk,
      kid: key.keyId,
      iss: "oneon",
      aud: issuer,
      now: this.clock(),
      claims: { code: input.code, oneonPublicKeyJwk: key.publicKeyJwk, oneonKeyId: key.keyId, oneonOrigin: this.deps.oneonOrigin, nonce },
    });
    const body = await this.post(origin, "/api/oneon/enrol", { request });
    if (body.status !== 200) throw new EnrolmentFailedError();
    const reply = await this.readResponse(body);

    // The reply is verified with the key it announces; the single-use code is what ties it to the real deployment.
    let verified: VerifiedJws;
    try {
      const claimed = decodeJwt(reply) as { deploymentKeyId?: unknown; deploymentPublicKeyJwk?: unknown };
      verified = await verifyJws(reply, {
        resolveKey: (kid) => (kid === claimed.deploymentKeyId ? (claimed.deploymentPublicKeyJwk as JWK) : null),
        issuer,
        audience: "oneon",
        now: this.clock(),
      });
    } catch {
      throw new EnrolmentFailedError();
    }
    const claims = verified.payload;
    if (
      claims.nonce !== nonce ||
      claims.tenantSlug !== input.tenantSlug ||
      claims.deploymentKeyId !== verified.kid ||
      typeof claims.deploymentPublicKeyJwk !== "object" ||
      claims.deploymentPublicKeyJwk === null
    ) {
      throw new EnrolmentFailedError();
    }

    return this.deps.repo.create({
      tenantSlug: input.tenantSlug,
      displayName: input.displayName?.trim() || input.tenantSlug,
      origin,
      deploymentKeyId: verified.kid,
      deploymentPublicKeyJwk: claims.deploymentPublicKeyJwk as JWK,
      oneonKeyId: key.keyId,
      oneonPublicKeyJwk: key.publicKeyJwk,
      oneonPrivateKeySealed: sealSecret(JSON.stringify(key.privateKeyJwk), master),
      enrolledBy: input.enrolledBy,
    });
  }

  /** Current Oneon signing key, decrypted on demand. For later tasks that sign requests to a deployment. */
  async oneonSigningKey(registrationId: string): Promise<{ keyId: string; privateKeyJwk: JWK }> {
    const master = this.master();
    const current = this.deps.repo.currentOneonKey(registrationId);
    if (!current) throw new EnrolmentFailedError("No signing key");
    return { keyId: current.keyId, privateKeyJwk: JSON.parse(openSecret(current.sealedPrivateKey, master)) as JWK };
  }

  /** Registers a new Oneon key at the deployment (signed with the current one), then stores it; the old key keeps working for 7 days. */
  async rotateOneonKey(registrationId: string, actor: string | null = null): Promise<void> {
    const master = this.master();
    const registration = this.activeRegistration(registrationId);
    const current = await this.oneonSigningKey(registrationId);
    const next = await generateEd25519Key();

    const request = await signJws({
      privateKeyJwk: current.privateKeyJwk,
      kid: current.keyId,
      iss: "oneon",
      aud: `impressorx:${registration.tenantSlug}`,
      now: this.clock(),
      claims: { newKeyId: next.keyId, newPublicKeyJwk: next.publicKeyJwk },
    });
    const res = await this.post(registration.origin, "/api/oneon/keys", { request });
    if (res.status !== 204) throw new EnrolmentFailedError();
    this.deps.repo.addOneonKey(registrationId, next.keyId, next.publicKeyJwk, sealSecret(JSON.stringify(next.privateKeyJwk), master), actor);
  }

  /** Fetches the deployment's key list, verifies it with a key already known, and stores it. */
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
      if (typeof k.keyId !== "string" || typeof k.publicKeyJwk !== "object" || k.publicKeyJwk === null) throw new EnrolmentFailedError();
      return { keyId: k.keyId, publicKeyJwk: k.publicKeyJwk as JWK, retiresAt: typeof k.retiresAt === "string" ? k.retiresAt : null };
    });
    this.deps.repo.replaceDeploymentKeys(registrationId, keys);
  }

  /**
   * Verifies a message from a deployment with its known keys. On a signature failure the key list is refreshed once and
   * the check repeated before the message is refused.
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
    try {
      return await attempt();
    } catch {
      await this.refreshDeploymentKeys(registrationId);
      return attempt();
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
