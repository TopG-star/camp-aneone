import type { RequestHandler } from "express";

/**
 * Middleware that enforces Level B auth — requires req.userId to be set.
 * Must be applied AFTER the composite auth middleware (session + token).
 *
 * Returns 401 if the user is not authenticated with a session that provided a userId.
 * This ensures all downstream route handlers can safely use `req.userId!`.
 */
export const requireUser: RequestHandler = (req, res, next) => {
  if (!req.userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  next();
};
