import type { RequestHandler } from "express";
import { timingSafeEqual } from "node:crypto";

/**
 * Minimal token-based auth middleware.
 *
 * Expects `Authorization: Bearer <token>` header.
 * Uses constant-time comparison to prevent timing attacks.
 * Intended as a simple MVP gate for the single-user dashboard.
 */
export function createTokenAuthMiddleware(
  expectedToken: string,
): RequestHandler {
  const expectedBuf = Buffer.from(expectedToken, "utf-8");

  return (req, res, next) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const token = header.slice(7); // "Bearer ".length === 7
    if (token.length === 0) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const tokenBuf = Buffer.from(token, "utf-8");

    // Constant-time comparison: pad shorter buffer to prevent length leak
    if (tokenBuf.length !== expectedBuf.length) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    if (!timingSafeEqual(tokenBuf, expectedBuf)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    next();
  };
}
