import type { RequestHandler } from "express";
import { jwtDecrypt } from "jose";
import { subtle, randomUUID } from "node:crypto";
import type { IdentityRepository, MembershipRepository } from "@oneon/infrastructure";
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
  /** Empty for a hand-off session, which has no email. */
  email: string;
  name?: string;
  picture?: string;
  sub?: string;
  /** Which sign-in produced the session. A token from before this field existed is a Google one. */
  provider: string;
  /** Hand-off sessions only. */
  identityId?: string;
  sessionId?: string;
  /** Always set on a hand-off session; on a Google session only when the person chose a pharmacy (otherwise personal). */
  activeContext?: { kind: "tenant"; membershipId: string };
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

    const provider = payload.provider === undefined ? "google" : payload.provider;
    if (provider !== "google" && provider !== "impressorx") {
      return null;
    }
    const sub = typeof payload.sub === "string" && payload.sub ? payload.sub : undefined;

    if (provider === "impressorx") {
      // A hand-off session is identified by identityId and bound to a session id; it has no email and no Google sub.
      const context = payload.activeContext as { kind?: unknown; membershipId?: unknown } | undefined;
      if (
        typeof payload.identityId !== "string" || !payload.identityId ||
        typeof payload.sessionId !== "string" || !payload.sessionId ||
        context?.kind !== "tenant" || typeof context.membershipId !== "string" || !context.membershipId
      ) {
        return null;
      }
      return {
        email: "",
        provider,
        sub,
        identityId: payload.identityId,
        sessionId: payload.sessionId,
        activeContext: { kind: "tenant", membershipId: context.membershipId },
      };
    }

    if (!payload.email || typeof payload.email !== "string") {
      return null;
    }
    // A Google session is personal unless the person chose a pharmacy with the context picker. Whatever it names is
    // checked again on every request (resolveActiveContext), so this only carries the choice.
    const chosen = payload.activeContext as { kind?: unknown; membershipId?: unknown } | undefined;
    const activeContext =
      chosen?.kind === "tenant" && typeof chosen.membershipId === "string" && chosen.membershipId
        ? ({ kind: "tenant", membershipId: chosen.membershipId } as const)
        : undefined;
    return {
      email: (payload.email as string).toLowerCase(),
      name: payload.name as string | undefined,
      picture: payload.picture as string | undefined,
      sub,
      provider,
      ...(activeContext ? { activeContext } : {}),
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

/** What a hand-off session is checked against on every request. Without it, hand-off sessions are signed out. */
export interface HandoffSessionChecks {
  memberships: Pick<MembershipRepository, "findById">;
  identities: Pick<IdentityRepository, "findById">;
  /** True while the session's attended grant is active (not signed out, revoked or expired). */
  hasActiveSession: (sessionId: string, identityId: string, membershipId: string) => boolean;
}

/**
 * Session-based auth middleware for Auth.js v5.
 * Reads the session cookie, decrypts the JWE and resolves an identity from Google's stable `sub`.
 * A session without `sub` is treated as signed out. Email is never used to find an identity, except
 * once per pre-existing user to attach their `sub` (spec §4.2). A new user is created as an identity
 * plus a personal `users` row with the same id. Sets req.identityId and req.userId (the same value).
 *
 * The session's `provider` decides how it resolves. A hand-off session (provider "impressorx") is resolved by its
 * identityId, never as a Google sub, and must still have an active membership of that identity and an active attended
 * grant for its sessionId; it also sets req.sessionId and req.sessionContext.
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
  handoff?: HandoffSessionChecks,
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
    if (!session) {
      return next(); // Invalid token: signed out
    }
    if (session.provider === "impressorx") {
      let handoffIdentityId: string | null = null;
      try {
        handoffIdentityId = resolveHandoffSession(session, handoff);
      } catch (err) {
        // Fail closed; never log the token.
        logger?.warn("Hand-off session check failed", { error: err instanceof Error ? err.message : String(err) });
      }
      if (handoffIdentityId) {
        req.identityId = handoffIdentityId;
        req.userId = handoffIdentityId;
        req.sessionId = session.sessionId;
        req.sessionContext = session.activeContext;
      }
      return next();
    }
    if (!session.sub) {
      return next(); // No sub: signed out
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
      if (session.activeContext) req.sessionContext = session.activeContext;
    }

    next();
  };
}

/** The identity id of a valid hand-off session, or null (signed out). */
function resolveHandoffSession(
  session: SessionPayload,
  handoff: HandoffSessionChecks | undefined,
): string | null {
  if (!handoff || !session.identityId || !session.sessionId || !session.activeContext) return null;
  const membership = handoff.memberships.findById(session.activeContext.membershipId);
  if (!membership || membership.status !== "active" || membership.identityId !== session.identityId) return null;
  const identity = handoff.identities.findById(session.identityId);
  if (!identity || identity.status !== "active") return null;
  if (!handoff.hasActiveSession(session.sessionId, session.identityId, session.activeContext.membershipId)) return null;
  return identity.id;
}
