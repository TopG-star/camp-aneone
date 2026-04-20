import { Router } from "express";
import type { UserRepository, OAuthTokenRepository, Logger } from "@oneon/domain";

export interface IntegrationsRouteDeps {
  userRepo: UserRepository;
  oauthTokenRepo: OAuthTokenRepository;
  logger: Logger;
}

export function createIntegrationsRouter(deps: IntegrationsRouteDeps): Router {
  const router = Router();
  const { userRepo, oauthTokenRepo, logger } = deps;

  router.post("/github/connect", async (req, res) => {
    try {
      const { token } = req.body ?? {};
      const userId = req.userId!;

      if (!token) {
        return res.status(400).json({ error: "token is required" });
      }

      const user = userRepo.findById(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const ghRes = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
        },
      });

      if (!ghRes.ok) {
        return res.status(401).json({ error: "Invalid GitHub token" });
      }

      const ghUser = (await ghRes.json()) as { login: string; email: string | null };

      const now = new Date().toISOString();
      oauthTokenRepo.upsert({
        provider: "github",
        userId,
        accessToken: token,
        refreshToken: null,
        tokenType: "bearer",
        scope: "",
        expiresAt: null,
        providerEmail: ghUser.email,
        createdAt: now,
        updatedAt: now,
      });

      logger.info("GitHub PAT connected", { userId, login: ghUser.login });

      return res.json({ connected: true, login: ghUser.login, email: ghUser.email });
    } catch (err) {
      logger.error("GitHub connect error", { error: err instanceof Error ? err.message : String(err) });
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/github/disconnect", async (req, res) => {
    try {
      const userId = req.userId!;

      const existing = oauthTokenRepo.get("github", userId);
      if (!existing) {
        return res.status(404).json({ error: "No GitHub token found" });
      }

      oauthTokenRepo.delete("github", userId);
      logger.info("GitHub PAT disconnected", { userId });

      return res.json({ disconnected: true });
    } catch (err) {
      logger.error("GitHub disconnect error", { error: err instanceof Error ? err.message : String(err) });
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
