import { OAuth2Client } from "google-auth-library";

/**
 * Abstract boundary for obtaining a Google API access token.
 * Consumers never know *how* the token was produced.
 */
export interface TokenProvider {
  getAccessToken(): Promise<string>;
}

/**
 * Token provider backed by a refresh token stored in an environment variable.
 * Delegates to google-auth-library's OAuth2Client for token refresh & caching.
 *
 * Swap this for a DB-backed provider when the auth endpoint ships in Phase 9.
 */
export class EnvRefreshTokenProvider implements TokenProvider {
  private readonly client: OAuth2Client;

  constructor(config: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  }) {
    this.client = new OAuth2Client(config.clientId, config.clientSecret);
    this.client.setCredentials({ refresh_token: config.refreshToken });
  }

  async getAccessToken(): Promise<string> {
    const { token } = await this.client.getAccessToken();
    if (!token) {
      throw new Error("Failed to obtain access token");
    }
    return token;
  }
}
