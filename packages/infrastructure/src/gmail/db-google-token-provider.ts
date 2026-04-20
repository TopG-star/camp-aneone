import { OAuth2Client } from "google-auth-library";
import type { TokenProvider } from "./token-provider.js";
import type { OAuthTokenRepository } from "@oneon/domain";

const REFRESH_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export class DbGoogleTokenProvider implements TokenProvider {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly userId: string;
  private readonly oauthTokenRepo: OAuthTokenRepository;

  constructor(
    oauthTokenRepo: OAuthTokenRepository,
    clientId: string,
    clientSecret: string,
    userId: string,
  ) {
    this.oauthTokenRepo = oauthTokenRepo;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.userId = userId;
  }

  async getAccessToken(): Promise<string> {
    const token = this.oauthTokenRepo.get("google", this.userId);
    if (!token) {
      throw new Error("Google not connected");
    }

    const needsRefresh = this.isExpiredOrSoon(token.expiresAt);

    if (!needsRefresh) {
      return token.accessToken;
    }

    // Refresh the token
    const client = new OAuth2Client(this.clientId, this.clientSecret);
    client.setCredentials({ refresh_token: token.refreshToken! });

    const result = await client.getAccessToken();
    const newAccessToken = result.token;
    if (!newAccessToken) {
      throw new Error("Token refresh failed");
    }

    // Extract real expiry_date from response
    const resData = (result.res as { data?: Record<string, unknown> } | undefined)?.data;
    const expiryDate = resData?.expiry_date as number | undefined;
    const newExpiresAt = expiryDate
      ? new Date(expiryDate).toISOString()
      : token.expiresAt;

    // Preserve existing refresh token if Google doesn't return a new one
    const newRefreshToken =
      (resData?.refresh_token as string | undefined) ?? token.refreshToken;

    this.oauthTokenRepo.upsert({
      ...token,
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      expiresAt: newExpiresAt,
      updatedAt: new Date().toISOString(),
    });

    return newAccessToken;
  }

  private isExpiredOrSoon(expiresAt: string | null): boolean {
    if (!expiresAt) return true;
    const expiryMs = new Date(expiresAt).getTime();
    return Date.now() >= expiryMs - REFRESH_THRESHOLD_MS;
  }
}
