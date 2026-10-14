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
      /** The pharmacy the session works in: always set for a hand-off session, and for a Google session only after the person chose one (otherwise personal) */
      sessionContext?: { kind: "tenant"; membershipId: string };
      /** Set by resolveActiveContext: the context this request runs in */
      activeContext?: import("@oneon/domain").ActiveContext;
      /** Set by resolveActiveContext: the active context's database, valid for this request only */
      contextDb?: import("@oneon/domain").ContextDb;
      /**
       * Set by resolveActiveContext: runs `fn` holding the context's database open until it is done. For a tenant it retains the request's
       * own lease (the very handle in `contextDb`; nothing is opened). A handler that keeps using `contextDb` after an await goes through
       * it, because the request's own lease ends when the client disconnects. Call it before the handler's first await: it is refused
       * with a TenantRefusedError only once the request's lease has ended, which a route answers as 403 context_unavailable.
       */
      holdContext?: <T>(fn: () => T) => T;
    }
  }
}

export {};
