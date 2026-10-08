import { randomUUID } from "node:crypto";
import { decodeJwt } from "jose";
import { generateEd25519Key, signJws, verifyJws, type GeneratedKey, type JWK } from "../crypto/jws.js";

/**
 * An in-memory ImpressoRx deployment that behaves like the real endpoints
 * (POST /api/oneon/enrol, POST and GET /api/oneon/keys). Every refusal is a bare 401.
 * Tests hand `fake.fetch` to the code under test. Task 12 extends it with the token endpoints.
 */
export class FakeImpressorx {
  /** Test switches. */
  signReplyWithWrongKey = false;
  replyTenantSlug: string | null = null;

  readonly oneonKeys: Array<{ keyId: string; publicKeyJwk: JWK; retiredAt: Date | null }> = [];
  readonly acceptedOneonKeyIds: string[] = [];
  private readonly deploymentKeys: Array<GeneratedKey & { retiredAt: Date | null }> = [];
  private codeUsed = false;
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
    } catch {
      return unauthorized();
    }
    return new Response(null, { status: 404 });
  };

  private async enrol(init?: RequestInit): Promise<Response> {
    if (this.codeUsed) return unauthorized();
    const token = requestToken(init);
    const unverified = decodeJwt(token) as { oneonPublicKeyJwk?: JWK; oneonKeyId?: string };
    const { payload, kid } = await verifyJws(token, {
      resolveKey: (k) => (k === unverified.oneonKeyId ? unverified.oneonPublicKeyJwk : null),
      issuer: "oneon",
      audience: this.issuer,
      now: this.clock(),
    });
    if (payload.code !== this.code || typeof payload.nonce !== "string" || !unverified.oneonPublicKeyJwk) return unauthorized();
    if (typeof payload.oneonOrigin !== "string" || !payload.oneonOrigin.startsWith("https://")) return unauthorized();
    this.codeUsed = true;
    this.oneonKeys.push({ keyId: kid, publicKeyJwk: unverified.oneonPublicKeyJwk, retiredAt: null });
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
        deploymentPublicKeyJwk: key.publicKeyJwk,
      },
    });
    return json({ response });
  }

  private async addOneonKey(init?: RequestInit): Promise<Response> {
    if (!this.codeUsed) return unauthorized();
    const now = this.clock();
    const { payload, kid } = await verifyJws(requestToken(init), {
      // A key that is retiring is refused, like the real endpoint.
      resolveKey: (k) => this.oneonKeys.find((o) => o.keyId === k && !o.retiredAt)?.publicKeyJwk ?? null,
      issuer: "oneon",
      audience: this.issuer,
      now,
    });
    if (typeof payload.newKeyId !== "string" || typeof payload.newPublicKeyJwk !== "object" || !payload.newPublicKeyJwk) return unauthorized();
    this.acceptedOneonKeyIds.push(kid);
    for (const key of this.oneonKeys) {
      if (!key.retiredAt) key.retiredAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    }
    this.oneonKeys.push({ keyId: payload.newKeyId, publicKeyJwk: payload.newPublicKeyJwk as JWK, retiredAt: null });
    return new Response(null, { status: 204 });
  }

  private async listKeys(): Promise<Response> {
    if (!this.codeUsed) return unauthorized();
    const now = this.clock();
    const signer = [...this.deploymentKeys].reverse().find((k) => !k.retiredAt)!;
    const keys = this.deploymentKeys
      .filter((k) => !k.retiredAt || k.retiredAt > now)
      .map((k) => ({ keyId: k.keyId, publicKeyJwk: k.publicKeyJwk, retiresAt: k.retiredAt?.toISOString() ?? null }));
    const usedSigner = this.signReplyWithWrongKey ? await generateEd25519Key() : signer;
    const response = await signJws({
      privateKeyJwk: usedSigner.privateKeyJwk,
      kid: signer.keyId,
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
const unauthorized = () =>
  new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
