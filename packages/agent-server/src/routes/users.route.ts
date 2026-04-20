import { Router } from "express";
import type { UserRepository, Logger } from "@oneon/domain";

export interface UsersRouteDeps {
  userRepo: UserRepository;
  logger: Logger;
}

export function createUsersRouter(deps: UsersRouteDeps): Router {
  const router = Router();
  const { userRepo, logger } = deps;

  // POST /upsert — create or find user by email (called from NextAuth sign-in callback)
  router.post("/upsert", (req, res) => {
    try {
      const { email } = req.body ?? {};
      if (!email || typeof email !== "string") {
        return res.status(400).json({ error: "email is required" });
      }

      const normalizedEmail = email.trim().toLowerCase();
      const existing = userRepo.findByEmail(normalizedEmail);
      if (existing) {
        return res.json({ user: existing, created: false });
      }

      const id = crypto.randomUUID();
      const user = userRepo.upsert({ id, email: normalizedEmail });
      logger.info("User created via sign-in", { userId: id, email: normalizedEmail });
      return res.json({ user, created: true });
    } catch (err) {
      logger.error("User upsert error", { error: err instanceof Error ? err.message : String(err) });
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
