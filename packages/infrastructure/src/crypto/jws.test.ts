import { beforeAll, describe, expect, it } from "vitest";
import { generateEd25519Key, parsePublicJwk, signJws, verifyJws, type GeneratedKey } from "./jws.js";

const T0 = new Date("2026-10-08T12:00:00.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

describe("jws", () => {
  let key: GeneratedKey;
  beforeAll(async () => {
    key = await generateEd25519Key();
  });

  const sign = (now: Date, extra: Record<string, unknown> = {}, ttlSeconds?: number) =>
    signJws({ privateKeyJwk: key.privateKeyJwk, kid: key.keyId, iss: "oneon", aud: "impressorx:acme", claims: extra, now, ttlSeconds });
  const verify = (token: string, now: Date, extra: object = {}) =>
    verifyJws(token, {
      resolveKey: (kid) => (kid === key.keyId ? key.publicKeyJwk : null),
      issuer: "oneon",
      audience: "impressorx:acme",
      now,
      ...extra,
    });

  it("verifies a good message and returns its claims", async () => {
    const result = await verify(await sign(T0, { hello: "world" }), T0);
    expect(result.payload.hello).toBe("world");
    expect(result.kid).toBe(key.keyId);
  });

  it("accepts a 29-second clock skew and refuses 31 seconds", async () => {
    expect(await verify(await sign(at(29)), T0)).toBeDefined();
    await expect(verify(await sign(at(31)), T0)).rejects.toThrow();
    // Expired messages follow the same leeway.
    const old = await sign(T0, {}, 60);
    expect(await verify(old, at(60 + 29))).toBeDefined();
    await expect(verify(old, at(60 + 31))).rejects.toThrow();
  });

  it("refuses wrong issuer, wrong audience, unknown kid and a lifetime above the maximum", async () => {
    const token = await sign(T0);
    await expect(verify(token, T0, { issuer: "other" })).rejects.toThrow();
    await expect(verify(token, T0, { audience: "other" })).rejects.toThrow();
    await expect(verify(token, T0, { resolveKey: () => null })).rejects.toThrow();
    await expect(verify(token, T0, { maxTtlSeconds: 60 })).rejects.toThrow();
    await expect(sign(T0, {}, 301)).rejects.toThrow();
  });

  it("refuses a message signed by another key", async () => {
    const other = await generateEd25519Key();
    const token = await signJws({ privateKeyJwk: other.privateKeyJwk, kid: key.keyId, iss: "oneon", aud: "impressorx:acme", now: T0 });
    await expect(verify(token, T0)).rejects.toThrow();
  });

  it("rejects a reused jti and does not burn the jti of an invalid message", async () => {
    const used = new Set<string>();
    const consumeJti = (jti: string) => (used.has(jti) ? false : (used.add(jti), true));
    const token = await sign(T0);
    await verify(token, T0, { consumeJti });
    await expect(verify(token, T0, { consumeJti })).rejects.toThrow();

    const bad = await sign(at(100));
    await expect(verify(bad, T0, { consumeJti })).rejects.toThrow();
    expect(used.size).toBe(1);
  });

  it("hands consumeJti an expiry that includes the 30-second leeway the verifier still accepts", async () => {
    let handed = "";
    const token = await sign(T0, {}, 60);
    await verify(token, T0, { consumeJti: (_jti: string, expiresAt: string) => ((handed = expiresAt), true) });
    expect(handed).toBe(at(60 + 30).toISOString());
  });

  it("parsePublicJwk accepts only a JSON string holding a public Ed25519 key", () => {
    expect(parsePublicJwk(JSON.stringify(key.publicKeyJwk))).toEqual(key.publicKeyJwk);
    expect(parsePublicJwk(key.publicKeyJwk)).toBeNull(); // an object is not a string
    expect(parsePublicJwk(JSON.stringify(key.privateKeyJwk))).toBeNull(); // has d
    expect(parsePublicJwk(JSON.stringify({ ...key.publicKeyJwk, crv: "P-256" }))).toBeNull();
    expect(parsePublicJwk(JSON.stringify({ kty: "OKP", crv: "Ed25519" }))).toBeNull();
    expect(parsePublicJwk("not json")).toBeNull();
  });
});
