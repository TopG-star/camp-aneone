import { Router } from "express";
import type { AppContainer } from "../container.js";
import type { Logger } from "@oneon/domain";

// ── Types ────────────────────────────────────────────────────

export interface StatusRouteDeps {
  container: AppContainer;
  logger: Logger;
}

// ── Router ───────────────────────────────────────────────────

export function createStatusRouter(deps: StatusRouteDeps): Router {
  const router = Router();
  const { container, logger } = deps;

  // ── GET / — Integration status overview ───────────────────
  router.get("/", (req, res) => {
    try {
      const userId = req.userId!;
      const integrations: Array<{
        name: string;
        connected: boolean;
        source?: "db" | "env" | "none";
        connectedAs?: string | null;
        detail?: string;
      }> = [];

      // Gmail / Outlook (inbound mail)
      const hasGoogleClientCreds =
        !!container.env.GOOGLE_CLIENT_ID && !!container.env.GOOGLE_CLIENT_SECRET;
      const gmailDb = container.oauthTokenRepo
        ? container.oauthTokenRepo.listByUser(userId).find((t) => t.provider === "google")
        : null;
      const gmailDbUsable = !!gmailDb && hasGoogleClientCreds;
      const gmailEnv =
        !!container.env.GOOGLE_CLIENT_ID &&
        !!container.env.GOOGLE_CLIENT_SECRET &&
        !!container.env.GOOGLE_REFRESH_TOKEN;

      let gmailDetail = "not configured";
      if (gmailDbUsable) {
        gmailDetail = "oauth";
      } else if (gmailDb && !hasGoogleClientCreds) {
        gmailDetail = "oauth token saved, missing Google client credentials";
      } else if (gmailEnv) {
        gmailDetail = "configured";
      }

      integrations.push({
        name: "gmail",
        connected: gmailDbUsable || gmailEnv,
        source: gmailDbUsable ? "db" : gmailEnv ? "env" : "none",
        connectedAs: gmailDbUsable ? gmailDb?.providerEmail ?? null : null,
        detail: gmailDetail,
      });

      // GitHub
      const githubDb = container.oauthTokenRepo
        ? container.oauthTokenRepo.listByUser(userId).find((t) => t.provider === "github")
        : null;
      const githubEnv = !!container.env.GITHUB_TOKEN;
      integrations.push({
        name: "github",
        connected: !!githubDb || githubEnv,
        source: githubDb ? "db" : githubEnv ? "env" : "none",
        connectedAs: githubDb?.providerEmail ?? null,
        detail: githubDb ? "pat" : githubEnv ? "token present" : "not configured",
      });

      // Calendar
      integrations.push({
        name: "calendar",
        connected: !!container.calendarPort,
        detail: container.calendarPort ? "connected" : "not configured",
      });

      // LLM
      const llmProvider = container.env.LLM_PROVIDER;
      const llmConnected =
        llmProvider === "deepseek"
          ? !!container.env.DEEPSEEK_API_KEY
          : !!container.env.ANTHROPIC_API_KEY;
      integrations.push({
        name: "llm",
        connected: llmConnected,
        detail: llmConnected ? llmProvider : "not configured",
      });

      // Notifications
      integrations.push({
        name: "notifications",
        connected: true,
        detail: "in-app",
      });

      res.json({
        integrations,
        uptime: process.uptime(),
      });
    } catch (error) {
      logger.error("Failed to fetch status", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
