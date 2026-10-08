import NextAuth, { CredentialsSignin, type NextAuthResult } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { redeemHandoff, signOutHandoff, type HandoffReason } from "./handoff";
import { applyContextUpdate, applySignIn } from "./session-token";
import { validateContextChoice } from "./context-validate";
import type { ContextChoice } from "./context";
import { sessionCookie } from "./session-cookie";
import { isSignInAllowed } from "./sign-in-policy";

declare module "next-auth" {
  interface User {
    sub?: string;
    identityId?: string;
    membershipId?: string;
    sessionId?: string;
  }
}

/** signIn rethrows this to its caller; its `code` is what /auth/impressorx turns into the message the person sees. */
class HandoffRejected extends CredentialsSignin {
  constructor(reason: HandoffReason) {
    super();
    this.code = reason;
  }
}

const allowedEmails = (process.env.ALLOWED_EMAILS ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

const cookie = sessionCookie();

/**
 * Asks the agent-server to validate a context switch with the requester's own session cookie. Only the Auth.js route
 * handler calls this (the `jwt` callback on `update()`), so the incoming request is the person's own and carries
 * their cookie; anywhere else there is no request to read and the answer is no.
 */
async function validateAsRequester(choice: ContextChoice): Promise<boolean> {
  try {
    const { headers } = await import("next/headers");
    const incoming = await headers();
    return validateContextChoice(choice, {
      cookie: incoming.get("cookie") ?? "",
      forwardedProto: incoming.get("x-forwarded-proto") ?? (cookie.useSecureCookies ? "https" : undefined),
    });
  } catch {
    return false;
  }
}

export const {
  handlers,
  auth,
  signIn,
  signOut,
}: NextAuthResult = NextAuth({
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
    // A staff member arriving from ImpressoRx. Only /auth/impressorx calls this, with a hand-off and the request Origin.
    Credentials({
      id: "impressorx",
      name: "ImpressoRx",
      credentials: { handoff: {}, origin: {} },
      async authorize(credentials) {
        const { handoff, origin } = credentials ?? {};
        if (typeof handoff !== "string" || typeof origin !== "string") throw new HandoffRejected("generic");
        // The session id is ours alone: this provider is also reachable at /api/auth/callback/impressorx, so nothing
        // the caller sends may choose it.
        const sessionId = crypto.randomUUID(); // Web Crypto: this module also loads in the edge middleware
        const result = await redeemHandoff(handoff, sessionId, origin);
        if (!result.ok) throw new HandoffRejected(result.reason);
        return { id: result.identityId, identityId: result.identityId, membershipId: result.membershipId, sessionId };
      },
    }),
  ],
  useSecureCookies: cookie.useSecureCookies,
  cookies: { sessionToken: { name: cookie.name, options: cookie.options } },
  callbacks: {
    async signIn({ account, profile }) {
      // The hand-off was verified by the agent-server; the Google allow-list does not apply to it.
      if (account?.provider === "impressorx") return true;
      return isSignInAllowed(profile, allowedEmails);
    },
    async jwt({ token, user, account, profile, trigger, session }) {
      // session.update({ activeContext }): the browser's request is stored only once the agent-server has validated it.
      if (trigger === "update") {
        return applyContextUpdate(token, (session as { activeContext?: unknown } | null | undefined)?.activeContext, validateAsRequester);
      }
      return applySignIn(token, { account, user, profile });
    },
    async session({ session, token }) {
      if (session.user && token.email) {
        session.user.email = token.email as string;
      }
      if (session.user && token.sub) {
        session.user.sub = token.sub;
      }
      return session;
    },
  },
  events: {
    async signOut(message) {
      const token = "token" in message ? message.token : null;
      if (token?.provider === "impressorx" && typeof token.sessionId === "string") {
        await signOutHandoff(token.sessionId);
      }
    },
  },
  pages: {
    signIn: "/auth/signin",
    error: "/auth/error",
  },
});
