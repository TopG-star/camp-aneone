import { Router } from "express";
import { randomBytes } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import type {
  UserRepository,
  OAuthTokenRepository,
  PreferenceRepository,
  Logger,
} from "@oneon/domain";

// ── Types ────────────────────────────────────────────────────

export interface OAuthRouteDeps {
  userRepo: UserRepository;
  oauthTokenRepo: OAuthTokenRepository;
  preferenceRepo: PreferenceRepository;
  googleClientId: string;
  googleClientSecret: string;
  publicUrl: string;
  allowedEmails: string[];
  logger: Logger;
}

interface OAuthState {
  returnTo: string;
  userId: string;
  createdAt: string;
}

// ── Constants ────────────────────────────────────────────────

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
];

// ── Helpers ──────────────────────────────────────────────────

function isValidReturnTo(returnTo: string): boolean {
  // Must start with / and not contain protocol-relative or backslash patterns
  if (!returnTo.startsWith("/")) return false;
  if (returnTo.startsWith("//")) return false;
  if (returnTo.includes("\\")) return false;
  // No protocol scheme like http:, javascript:, data:, etc.
  if (/^\/[a-zA-Z][a-zA-Z0-9+.-]*:/.test(returnTo)) return false;
  return true;
}

// ── Router ───────────────────────────────────────────────────

export function createOAuthRouter(deps: OAuthRouteDeps): Router {
  const router = Router();
  const {
    userRepo,
    oauthTokenRepo,
    preferenceRepo,
    googleClientId,
    googleClientSecret,
    publicUrl,
    allowedEmails,
    logger,
  } = deps;

  // ── GET /start/google — Initiate Google OAuth ─────────────
  router.get("/start/google", (req, res) => {
    try {
      const userId = req.userId;
      if (!userId) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      // Verify user exists
      const user = userRepo.findById(userId);
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      let returnTo = (req.query.returnTo as string) || "/settings";
      if (!isValidReturnTo(returnTo)) {
        res.status(400).json({ error: "Invalid returnTo path" });
        return;
      }

      // Generate state for CSRF protection
      const state = randomBytes(32).toString("hex");
      const statePayload: OAuthState = {
        returnTo,
        userId,
        createdAt: new Date().toISOString(),
      };
      preferenceRepo.set(`oauth_state:${state}`, JSON.stringify(statePayload));

      // Build Google OAuth URL
      const client = new OAuth2Client(googleClientId, googleClientSecret);
      const url = client.generateAuthUrl({
        redirect_uri: `${publicUrl}/api/oauth/callback/google`,
        scope: GOOGLE_SCOPES,
        access_type: "offline",
        prompt: "consent",
        state,
        include_granted_scopes: true,
      });

      res.json({ url });
    } catch (error) {
      logger.error("OAuth start failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── GET /callback/google — Handle Google OAuth redirect ───
  router.get("/callback/google", async (req, res) => {
    const state = req.query.state as string | undefined;
    const fallbackRedirect = `${publicUrl}/settings`;

    if (!state) {
      res.redirect(`${fallbackRedirect}?error=invalid_state`);
      return;
    }

    const stateKey = `oauth_state:${state}`;
    const rawState = preferenceRepo.get(stateKey);

    if (!rawState) {
      res.redirect(`${fallbackRedirect}?error=invalid_state`);
      return;
    }

    let statePayload: OAuthState;
    try {
      statePayload = JSON.parse(rawState) as OAuthState;
    } catch {
      preferenceRepo.delete(stateKey);
      res.redirect(`${fallbackRedirect}?error=invalid_state`);
      return;
    }

    const redirectTo = `${publicUrl}${statePayload.returnTo}`;

    // Check state age (10 min max)
    const stateAge = Date.now() - new Date(statePayload.createdAt).getTime();
    if (stateAge > STATE_TTL_MS) {
      preferenceRepo.delete(stateKey);
      res.redirect(`${redirectTo}?error=state_expired`);
      return;
    }

    // Always clean up state
    preferenceRepo.delete(stateKey);

    // Handle Google error response
    const googleError = req.query.error as string | undefined;
    if (googleError) {
      res.redirect(`${redirectTo}?error=${encodeURIComponent(googleError)}`);
      return;
    }

    const code = req.query.code as string | undefined;
    if (!code) {
      res.redirect(`${redirectTo}?error=no_code`);
      return;
    }

    try {
      // Exchange code for tokens
      const client = new OAuth2Client(
        googleClientId,
        googleClientSecret,
        `${publicUrl}/api/oauth/callback/google`,
      );
      const { tokens } = await client.getToken(code);

      if (!tokens.access_token) {
        res.redirect(`${redirectTo}?error=token_exchange_failed`);
        return;
      }

      // Get user info from Google
      client.setCredentials(tokens);
      const userInfoRes = await client.request<{ email?: string }>({
        url: "https://openidconnect.googleapis.com/v1/userinfo",
      });
      const googleEmail = userInfoRes.data?.email;

      // Validate email against allowed list
      if (!googleEmail || !allowedEmails.includes(googleEmail)) {
        logger.warn("OAuth callback: email not in allowed list", {
          googleEmail,
          allowedEmails,
        });
        res.redirect(`${redirectTo}?error=email_not_allowed`);
        return;
      }

      // Verify user still exists
      const user = userRepo.findById(statePayload.userId);
      if (!user) {
        res.redirect(`${redirectTo}?error=user_not_found`);
        return;
      }

      // Preserve existing refresh token if Google doesn't return one
      const existingToken = oauthTokenRepo.get("google", user.id);
      const refreshToken =
        tokens.refresh_token ??
        existingToken?.refreshToken ??
        null;

      const expiresAt = tokens.expiry_date
        ? new Date(tokens.expiry_date).toISOString()
        : null;

      oauthTokenRepo.upsert({
        provider: "google",
        userId: user.id,
        accessToken: tokens.access_token,
        refreshToken,
        tokenType: tokens.token_type ?? "bearer",
        scope: tokens.scope ?? GOOGLE_SCOPES.join(" "),
        expiresAt,
        providerEmail: googleEmail,
        createdAt: existingToken?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      logger.info("Google OAuth connected", {
        userId: user.id,
        googleEmail,
      });

      res.redirect(`${redirectTo}?connected=google`);
    } catch (error) {
      logger.error("OAuth callback failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.redirect(`${redirectTo}?error=callback_failed`);
    }
  });

  // ── POST /disconnect/google — Revoke + delete token ───────
  router.post("/disconnect/google", (req, res) => {
    try {
      const userId = req.userId;
      if (!userId) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const token = oauthTokenRepo.get("google", userId);
      if (!token) {
        res.status(404).json({ error: "No Google token found for this user" });
        return;
      }

      // Best-effort revoke with Google (fire and forget)
      if (token.accessToken) {
        const client = new OAuth2Client(googleClientId, googleClientSecret);
        client.revokeToken(token.accessToken).catch((err) => {
          logger.warn("Google token revocation failed (non-critical)", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }

      oauthTokenRepo.delete("google", userId);

      logger.info("Google OAuth disconnected", { userId });
      res.json({ disconnected: true });
    } catch (error) {
      logger.error("OAuth disconnect failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
