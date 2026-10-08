declare global {
  namespace Express {
    interface Request {
      /** Identity resolved from the session's Google sub */
      identityId?: string;
      /** Authenticated user's ID from the database */
      userId?: string;
      /** Authenticated user's email from session */
      userEmail?: string;
    }
  }
}

export {};
