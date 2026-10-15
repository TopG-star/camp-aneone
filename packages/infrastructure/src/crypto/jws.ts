import { randomUUID } from "node:crypto";
import { CompactSign, compactVerify, decodeProtectedHeader, exportJWK, generateKeyPair, importJWK, type JWK } from "jose";

export type { JWK };

/** Verifier leeway for clock skew (seconds). */
export const JWS_LEEWAY_SECONDS = 30;
export const JWS_MAX_TTL_SECONDS = 300;

export class JwsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JwsError";
  }
}

export interface SignJwsInput {
  privateKeyJwk: JWK;
  kid: string;
  iss: string;
  aud: string;
  claims?: Record<string, unknown>;
  /** Defaults to 300; never above 300. */
  ttlSeconds?: number;
  now?: Date;
  jti?: string;
}

export async function signJws(input: SignJwsInput): Promise<string> {
  const ttl = input.ttlSeconds ?? JWS_MAX_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > JWS_MAX_TTL_SECONDS) throw new JwsError("ttl out of range");
  const iat = Math.floor((input.now ?? new Date()).getTime() / 1000);
  // Reserved claims come last so a caller's claims cannot override them.
  const payload = { ...input.claims, iss: input.iss, aud: input.aud, iat, exp: iat + ttl, jti: input.jti ?? randomUUID() };
  const key = await importJWK(input.privateKeyJwk, "EdDSA");
  return new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg: "EdDSA", kid: input.kid })
    .sign(key);
}

export interface VerifyJwsOptions {
  /** Returns the public key for a header `kid`, or null when the kid is unknown. */
  resolveKey: (kid: string) => JWK | null | undefined;
  issuer: string;
  audience: string;
  now?: Date;
  maxTtlSeconds?: number;
  /** Returns false when the jti was already used. Called last, only for an otherwise valid message. The expiry handed over includes the leeway, so the record outlives the message's last accepted moment. */
  consumeJti?: (jti: string, expiresAt: string) => boolean;
}

export interface VerifiedJws {
  kid: string;
  payload: Record<string, unknown>;
}

export async function verifyJws(token: string, options: VerifyJwsOptions): Promise<VerifiedJws> {
  let kid: string;
  let payload: Record<string, unknown>;
  try {
    const header = decodeProtectedHeader(token);
    if (header.alg !== "EdDSA" || typeof header.kid !== "string") throw new JwsError("bad header");
    kid = header.kid;
    const jwk = options.resolveKey(kid);
    if (!jwk) throw new JwsError("unknown key");
    if ("d" in jwk) throw new JwsError("verification key must be public");
    const key = await importJWK(jwk, "EdDSA");
    const verified = await compactVerify(token, key, { algorithms: ["EdDSA"] });
    payload = JSON.parse(new TextDecoder().decode(verified.payload)) as Record<string, unknown>;
  } catch (error) {
    throw error instanceof JwsError ? error : new JwsError("invalid signature");
  }

  const { iss, aud, iat, exp, jti } = payload;
  if (iss !== options.issuer) throw new JwsError("wrong issuer");
  if (aud !== options.audience) throw new JwsError("wrong audience");
  if (!Number.isInteger(iat) || !Number.isInteger(exp)) throw new JwsError("missing times");
  if (typeof jti !== "string" || jti.length === 0) throw new JwsError("missing jti");
  const issuedAt = iat as number;
  const expiresAt = exp as number;
  if (expiresAt <= issuedAt || expiresAt - issuedAt > (options.maxTtlSeconds ?? JWS_MAX_TTL_SECONDS)) {
    throw new JwsError("lifetime out of range");
  }
  const nowSeconds = (options.now ?? new Date()).getTime() / 1000;
  if (issuedAt > nowSeconds + JWS_LEEWAY_SECONDS) throw new JwsError("issued in the future");
  if (expiresAt + JWS_LEEWAY_SECONDS < nowSeconds) throw new JwsError("expired");
  if (options.consumeJti && !options.consumeJti(jti, new Date((expiresAt + JWS_LEEWAY_SECONDS) * 1000).toISOString())) {
    throw new JwsError("replayed");
  }
  return { kid, payload };
}

export interface GeneratedKey {
  keyId: string;
  publicKeyJwk: JWK;
  privateKeyJwk: JWK;
}

export async function generateEd25519Key(): Promise<GeneratedKey> {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  return {
    keyId: randomUUID(),
    publicKeyJwk: await exportJWK(publicKey),
    privateKeyJwk: await exportJWK(privateKey),
  };
}

/** Parses a JWK that travels as a JSON string; null unless it is a public Ed25519 key. */
export function parsePublicJwk(value: unknown): JWK | null {
  if (typeof value !== "string") return null;
  try {
    const jwk = JSON.parse(value) as Record<string, unknown>;
    if (typeof jwk !== "object" || jwk === null) return null;
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string" || jwk.x.length === 0 || "d" in jwk) return null;
    return jwk as JWK;
  } catch {
    return null;
  }
}
