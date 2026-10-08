import type { RequestHandler } from "express";
import { jwtDecrypt } from "jose";
import { subtle, randomUUID } from "node:crypto";
import type { IdentityRepository } from "@oneon/infrastructure";
import type { Logger } from "@oneon/domain";

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
      sub: typeof payload.sub === "string" && payload.sub ? payload.sub : undefined,
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

export type SessionIdentities = Pick<IdentityRepository, "findByLogin" | "attachGoogleSubByEmailOnce" | "createWithLogin">;

/**
 * Session-based auth middleware for Auth.js v5.
 * Reads the session cookie, decrypts the JWE and resolves an identity from Google's stable `sub`.
 * A session without `sub` is treated as signed out. Email is never used to find an identity, except
 * once per pre-existing user to attach their `sub` (spec §4.2). A new user is created as an identity
 * plus a personal `users` row with the same id. Sets req.identityId and req.userId (the same value).
 *
 * Cookie names:
 *   Production (HTTPS): __Secure-authjs.session-token
 *   Development (HTTP):  authjs.session-token
 */
export function createSessionAuthMiddleware(
  nextauthSecret: string,
  identities: SessionIdentities,
  upsertUser?: (user: { id: string; email: string }) => { id: string },
  logger?: Logger,
): RequestHandler {
  return async (req, _res, next) => {
    const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "");
    const isForwardedHttps = forwardedProto
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .includes("https");

    const cookieName =
      req.secure || isForwardedHttps
        ? "__Secure-authjs.session-token"
        : "authjs.session-token";

    const token = readSessionTokenCookie(req.cookies, cookieName);
    if (!token) {
      return next(); // No session — let composite middleware try next strategy
    }

    const session = await decryptSessionToken(token, nextauthSecret, cookieName);
    if (!session || !session.sub) {
      return next(); // Invalid token, or no sub: signed out
    }

    let identity = identities.findByLogin("google", session.sub);
    if (!identity) identity = identities.attachGoogleSubByEmailOnce(session.email, session.sub);
    if (!identity && upsertUser) {
      // First request from a newly-authenticated user — auto-create
      const id = randomUUID();
      // The users row (personal DB) and the identity (control DB) are written in two databases, so this is not
      // atomic: if createWithLogin fails, an orphan users row remains. It is repaired by the startup backfill.
      try {
        upsertUser({ id, email: session.email });
        identity = identities.createWithLogin({ kind: "google", subject: session.sub, email: session.email, id });
      } catch (err) {
        if ((err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
          // The identity for this sub already exists (created by another request): use it.
          identity = identities.findByLogin("google", session.sub);
        } else {
          // Signed out for this request; never log the token or sub.
          logger?.warn("Session identity creation failed", { error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    if (identity && identity.status === "active") {
      req.identityId = identity.id;
      req.userId = identity.id;
      req.userEmail = session.email;
    }

    next();
  };
}
