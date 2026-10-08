import NextAuth, { CredentialsSignin, type NextAuthResult } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { redeemHandoff, signOutHandoff, type HandoffReason } from "./handoff";
import { applySignIn } from "./session-token";
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

/** Reaches the redirect as `code`, which /auth/impressorx turns into the message the person sees. */
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
    // A staff member arriving from ImpressoRx. Only /auth/impressorx calls this, with a hand-off and a session id.
    Credentials({
      id: "impressorx",
      name: "ImpressoRx",
      credentials: { handoff: {}, sessionId: {} },
      async authorize(credentials) {
        const { handoff, sessionId } = credentials ?? {};
        if (typeof handoff !== "string" || typeof sessionId !== "string") throw new HandoffRejected("generic");
        const result = await redeemHandoff(handoff, sessionId);
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
    async jwt({ token, user, account, profile }) {
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
