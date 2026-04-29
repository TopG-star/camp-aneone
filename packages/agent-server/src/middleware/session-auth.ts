import type { RequestHandler } from "express";
import { jwtDecrypt } from "jose";
import { subtle, randomUUID } from "node:crypto";

const AUTH_CONTENT_ENCRYPTION_ALGORITHMS = [
  "A256CBC-HS512",
  "A256GCM",
] as const;

type AuthContentEncryptionAlgorithm =
  (typeof AUTH_CONTENT_ENCRYPTION_ALGORITHMS)[number];

/**
 * Derives the same encryption key that Auth.js v5 uses internally.
 * Auth.js derives this via HKDF(secret, salt, `Auth.js Generated Encryption Key (${salt})`).
 */
async function deriveEncryptionKey(
  enc: AuthContentEncryptionAlgorithm,
  secret: string,
  salt: string,
): Promise<Uint8Array> {
  const lengthBits = enc === "A256CBC-HS512" ? 512 : 256;
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
      salt: encoder.encode(salt),
      info: encoder.encode(`Auth.js Generated Encryption Key (${salt})`),
    },
    ikm,
    lengthBits,
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
  salt: string,
): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtDecrypt(
      token,
      async ({ enc }) => {
        if (!AUTH_CONTENT_ENCRYPTION_ALGORITHMS.includes(enc as AuthContentEncryptionAlgorithm)) {
          throw new Error("Unsupported JWT Content Encryption Algorithm");
        }
        return deriveEncryptionKey(
          enc as AuthContentEncryptionAlgorithm,
          secret,
          salt,
        );
      },
      {
        clockTolerance: 15,
        keyManagementAlgorithms: ["dir"],
        contentEncryptionAlgorithms: [...AUTH_CONTENT_ENCRYPTION_ALGORITHMS],
      },
    );

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

function readSessionTokenCookie(
  cookies: Record<string, string | undefined> | undefined,
  cookieName: string,
): string | undefined {
  if (!cookies) {
    return undefined;
  }

  const baseToken = cookies[cookieName];
  if (baseToken) {
    return baseToken;
  }

  const prefix = `${cookieName}.`;
  const chunks = Object.entries(cookies)
    .filter(([name, value]) => name.startsWith(prefix) && typeof value === "string")
    .map(([name, value]) => ({
      index: Number.parseInt(name.slice(prefix.length), 10),
      value: value as string,
    }))
    .filter((chunk) => Number.isInteger(chunk.index) && chunk.index >= 0)
    .sort((a, b) => a.index - b.index);

  if (chunks.length === 0) {
    return undefined;
  }

  // Auth.js chunked cookies are indexed from 0..n with no gaps.
  for (let i = 0; i < chunks.length; i += 1) {
    if (chunks[i].index !== i) {
      return undefined;
    }
  }

  return chunks.map((chunk) => chunk.value).join("");
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

    const token = readSessionTokenCookie(req.cookies, cookieName);
    if (!token) {
      return next(); // No session — let composite middleware try next strategy
    }

    const session = await decryptSessionToken(token, nextauthSecret, cookieName);
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
