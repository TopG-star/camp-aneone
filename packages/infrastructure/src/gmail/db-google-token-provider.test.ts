import { describe, it, expect, vi, beforeEach } from "vitest";
import { DbGoogleTokenProvider } from "./db-google-token-provider.js";
import type { OAuthTokenRepository, OAuthToken } from "@oneon/domain";

function makeToken(overrides: Partial<OAuthToken> = {}): OAuthToken {
  return {
    provider: "google",
    userId: "u1",
    accessToken: "ya29.valid-access-token",
    refreshToken: "1//valid-refresh-token",
    tokenType: "bearer",
    scope: "openid email",
    expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    providerEmail: "alice@gmail.com",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockRepo(token: OAuthToken | null = null): OAuthTokenRepository {
  return {
    get: vi.fn().mockReturnValue(token),
    upsert: vi.fn(),
    delete: vi.fn(),
    listByUser: vi.fn().mockReturnValue(token ? [token] : []),
  };
}

// Mock google-auth-library
vi.mock("google-auth-library", () => {
  const mockGetAccessToken = vi.fn();
  const mockSetCredentials = vi.fn();

  return {
    OAuth2Client: vi.fn().mockImplementation(() => ({
      getAccessToken: mockGetAccessToken,
      setCredentials: mockSetCredentials,
    })),
    __mockGetAccessToken: mockGetAccessToken,
    __mockSetCredentials: mockSetCredentials,
  };
});

async function getMocks() {
  const mod = await import("google-auth-library");
  return {
    mockGetAccessToken: (mod as unknown as { __mockGetAccessToken: ReturnType<typeof vi.fn> }).__mockGetAccessToken,
    mockSetCredentials: (mod as unknown as { __mockSetCredentials: ReturnType<typeof vi.fn> }).__mockSetCredentials,
  };
}

describe("DbGoogleTokenProvider", () => {
  const CLIENT_ID = "test-client-id";
  const CLIENT_SECRET = "test-client-secret";
  const USER_ID = "u1";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns access token when not expired", async () => {
    const token = makeToken({
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 min from now
    });
    const repo = createMockRepo(token);
    const provider = new DbGoogleTokenProvider(repo, CLIENT_ID, CLIENT_SECRET, USER_ID);

    const accessToken = await provider.getAccessToken();
    expect(accessToken).toBe("ya29.valid-access-token");
    expect(repo.upsert).not.toHaveBeenCalled();
  });

  it("refreshes token when within 5 min of expiry", async () => {
    const { mockGetAccessToken } = await getMocks();
    mockGetAccessToken.mockResolvedValueOnce({
      token: "ya29.refreshed-token",
      res: {
        data: {
          access_token: "ya29.refreshed-token",
          expiry_date: Date.now() + 3500 * 1000,
        },
      },
    });

    const token = makeToken({
      expiresAt: new Date(Date.now() + 2 * 60 * 1000).toISOString(), // 2 min from now (< 5 min threshold)
    });
    const repo = createMockRepo(token);
    const provider = new DbGoogleTokenProvider(repo, CLIENT_ID, CLIENT_SECRET, USER_ID);

    const accessToken = await provider.getAccessToken();
    expect(accessToken).toBe("ya29.refreshed-token");
    expect(repo.upsert).toHaveBeenCalledTimes(1);

    const savedToken = (repo.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0] as OAuthToken;
    expect(savedToken.accessToken).toBe("ya29.refreshed-token");
    // Real expiry_date used
    expect(savedToken.expiresAt).toBeTruthy();
  });

  it("refreshes token when expiresAt is null", async () => {
    const { mockGetAccessToken } = await getMocks();
    mockGetAccessToken.mockResolvedValueOnce({
      token: "ya29.refreshed-token",
      res: {
        data: {
          access_token: "ya29.refreshed-token",
          expiry_date: Date.now() + 3600 * 1000,
        },
      },
    });

    const token = makeToken({ expiresAt: null });
    const repo = createMockRepo(token);
    const provider = new DbGoogleTokenProvider(repo, CLIENT_ID, CLIENT_SECRET, USER_ID);

    const accessToken = await provider.getAccessToken();
    expect(accessToken).toBe("ya29.refreshed-token");
    expect(repo.upsert).toHaveBeenCalledTimes(1);
  });

  it("preserves existing refresh token if exchange does not return one", async () => {
    const { mockGetAccessToken } = await getMocks();
    mockGetAccessToken.mockResolvedValueOnce({
      token: "ya29.new-access",
      res: {
        data: {
          access_token: "ya29.new-access",
          expiry_date: Date.now() + 3600 * 1000,
          // No refresh_token in response
        },
      },
    });

    const token = makeToken({
      expiresAt: new Date(Date.now() + 1 * 60 * 1000).toISOString(),
      refreshToken: "1//original-refresh",
    });
    const repo = createMockRepo(token);
    const provider = new DbGoogleTokenProvider(repo, CLIENT_ID, CLIENT_SECRET, USER_ID);

    await provider.getAccessToken();

    const savedToken = (repo.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0] as OAuthToken;
    expect(savedToken.refreshToken).toBe("1//original-refresh");
  });

  it("uses new refresh token if exchange returns one", async () => {
    const { mockGetAccessToken } = await getMocks();
    mockGetAccessToken.mockResolvedValueOnce({
      token: "ya29.new-access",
      res: {
        data: {
          access_token: "ya29.new-access",
          refresh_token: "1//new-refresh",
          expiry_date: Date.now() + 3600 * 1000,
        },
      },
    });

    const token = makeToken({
      expiresAt: new Date(Date.now() + 1 * 60 * 1000).toISOString(),
      refreshToken: "1//original-refresh",
    });
    const repo = createMockRepo(token);
    const provider = new DbGoogleTokenProvider(repo, CLIENT_ID, CLIENT_SECRET, USER_ID);

    await provider.getAccessToken();

    const savedToken = (repo.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0] as OAuthToken;
    expect(savedToken.refreshToken).toBe("1//new-refresh");
  });

  it("throws if no token in DB", async () => {
    const repo = createMockRepo(null);
    const provider = new DbGoogleTokenProvider(repo, CLIENT_ID, CLIENT_SECRET, USER_ID);

    await expect(provider.getAccessToken()).rejects.toThrow("Google not connected");
  });

  it("throws if refresh fails", async () => {
    const { mockGetAccessToken } = await getMocks();
    mockGetAccessToken.mockResolvedValueOnce({
      token: null,
      res: { data: {} },
    });

    const token = makeToken({
      expiresAt: new Date(Date.now() - 60 * 1000).toISOString(), // already expired
    });
    const repo = createMockRepo(token);
    const provider = new DbGoogleTokenProvider(repo, CLIENT_ID, CLIENT_SECRET, USER_ID);

    await expect(provider.getAccessToken()).rejects.toThrow("Token refresh failed");
  });
});
