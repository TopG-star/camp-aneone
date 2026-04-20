import type { OAuthToken } from "../entities.js";

export interface OAuthTokenRepository {
  get(provider: string, userId: string): OAuthToken | null;
  upsert(token: OAuthToken): void;
  delete(provider: string, userId: string): void;
  listByUser(userId: string): OAuthToken[];
}
