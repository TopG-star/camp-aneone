declare global {
  namespace Express {
    interface Request {
      /** Authenticated user's ID from the database */
      userId?: string;
      /** Authenticated user's email from session */
      userEmail?: string;
    }
  }
}

export {};
