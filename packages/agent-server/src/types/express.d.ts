declare global {
  namespace Express {
    interface Request {
      /** Identity resolved from the session's Google sub */
      identityId?: string;
      /** Authenticated user's ID from the database */
      userId?: string;
      /** Authenticated user's email from session */
      userEmail?: string;
      /** Hand-off sessions only: the dashboard-generated session id that the attended grant is bound to */
      sessionId?: string;
      /** Hand-off sessions only: the context the person is working in */
      activeContext?: { kind: "tenant"; membershipId: string };
    }
  }
}

export {};
