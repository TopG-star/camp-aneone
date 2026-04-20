import type { RequestHandler } from "express";
import { jwtDecrypt } from "jose";
import { subtle, randomUUID } from "node:crypto";

// Auth.js v5 derives the JWE encryption key using HKDF with this info string
const HKDF_INFO = "Auth.js Generated Encryption Key";

/**
 * Derives the same encryption key that Auth.js v5 uses internally.
 * Auth.js uses HKDF(SHA-256) with the user's NEXTAUTH_SECRET to derive a 64-byte key
 * for A256CBC-HS512 JWE encryption.
 */
async function deriveEncryptionKey(secret: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const ikm = await subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HKDF" },
    false,
    ["deriveBits"],
  );
  const bits = await subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: encoder.encode(HKDF_INFO),
    },
    ikm,
    512, // 64 bytes for A256CBC-HS512
  );
  return new Uint8Array(bits);
}

export interface SessionPayload {
  email: string;
  name?: string;
  picture?: string;
  sub?: string;
}

/**
 * Decrypts an Auth.js v5 JWE session token.
 */
export async function decryptSessionToken(
  token: string,
  secret: string,
): Promise<SessionPayload | null> {
  try {
    const key = await deriveEncryptionKey(secret);
    const { payload } = await jwtDecrypt(token, key, {
      clockTolerance: 15,
    });
    if (!payload.email || typeof payload.email !== "string") {
      return null;
    }
    return {
      email: (payload.email as string).toLowerCase(),
      name: payload.name as string | undefined,
      picture: payload.picture as string | undefined,
      sub: payload.sub,
    };
  } catch {
    return null;
  }
}

/**
 * Session-based auth middleware for Auth.js v5.
 * Reads the session cookie, decrypts the JWE, and sets req.userId + req.userEmail.
 *
 * If the user doesn't exist in the database yet (first request after sign-in),
 * the middleware auto-creates them via upsertUser. This eliminates the need for
 * the dashboard to call /api/users/upsert during the sign-in callback.
 *
 * Cookie names:
 *   Production (HTTPS): __Secure-authjs.session-token
 *   Development (HTTP):  authjs.session-token
 */
export function createSessionAuthMiddleware(
  nextauthSecret: string,
  findUserByEmail: (email: string) => { id: string } | null,
  upsertUser?: (user: { id: string; email: string }) => { id: string },
): RequestHandler {
  return async (req, _res, next) => {
    const cookieName =
      req.secure || req.headers["x-forwarded-proto"] === "https"
        ? "__Secure-authjs.session-token"
        : "authjs.session-token";

    const token = req.cookies?.[cookieName];
    if (!token) {
      return next(); // No session — let composite middleware try next strategy
    }

    const session = await decryptSessionToken(token, nextauthSecret);
    if (!session) {
      return next(); // Invalid token — let composite middleware try next strategy
    }

    let user = findUserByEmail(session.email);
    if (!user && upsertUser) {
      // First request from a newly-authenticated user — auto-create
      user = upsertUser({ id: randomUUID(), email: session.email });
    }
    if (user) {
      req.userId = user.id;
      req.userEmail = session.email;
    }

    next();
  };
}
