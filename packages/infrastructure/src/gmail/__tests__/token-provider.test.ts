import { describe, it, expect, vi, beforeEach } from "vitest";
import { EnvRefreshTokenProvider } from "../token-provider.js";

// ── Mock google-auth-library ─────────────────────────────────

const mockGetAccessToken = vi.fn();
const mockSetCredentials = vi.fn();

vi.mock("google-auth-library", () => ({
  OAuth2Client: vi.fn().mockImplementation(() => ({
    setCredentials: mockSetCredentials,
    getAccessToken: mockGetAccessToken,
  })),
}));

describe("EnvRefreshTokenProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets refresh token credentials on construction", () => {
    new EnvRefreshTokenProvider({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      refreshToken: "test-refresh-token",
    });

    expect(mockSetCredentials).toHaveBeenCalledWith({
      refresh_token: "test-refresh-token",
    });
  });

  it("returns access token from OAuth2Client", async () => {
    mockGetAccessToken.mockResolvedValue({ token: "access-token-123" });

    const provider = new EnvRefreshTokenProvider({
      clientId: "cid",
      clientSecret: "csec",
      refreshToken: "rt",
    });

    const token = await provider.getAccessToken();
    expect(token).toBe("access-token-123");
  });

  it("throws when getAccessToken returns null token", async () => {
    mockGetAccessToken.mockResolvedValue({ token: null });

    const provider = new EnvRefreshTokenProvider({
      clientId: "cid",
      clientSecret: "csec",
      refreshToken: "rt",
    });

    await expect(provider.getAccessToken()).rejects.toThrow(
      "Failed to obtain access token"
    );
  });

  it("throws when getAccessToken returns undefined token", async () => {
    mockGetAccessToken.mockResolvedValue({});

    const provider = new EnvRefreshTokenProvider({
      clientId: "cid",
      clientSecret: "csec",
      refreshToken: "rt",
    });

    await expect(provider.getAccessToken()).rejects.toThrow(
      "Failed to obtain access token"
    );
  });

  it("propagates OAuth2Client errors", async () => {
    mockGetAccessToken.mockRejectedValue(new Error("refresh_token revoked"));

    const provider = new EnvRefreshTokenProvider({
      clientId: "cid",
      clientSecret: "csec",
      refreshToken: "rt",
    });

    await expect(provider.getAccessToken()).rejects.toThrow(
      "refresh_token revoked"
    );
  });

  it("calls getAccessToken each invocation (library handles caching)", async () => {
    mockGetAccessToken
      .mockResolvedValueOnce({ token: "token-1" })
      .mockResolvedValueOnce({ token: "token-2" });

    const provider = new EnvRefreshTokenProvider({
      clientId: "cid",
      clientSecret: "csec",
      refreshToken: "rt",
    });

    expect(await provider.getAccessToken()).toBe("token-1");
    expect(await provider.getAccessToken()).toBe("token-2");
    expect(mockGetAccessToken).toHaveBeenCalledTimes(2);
  });
});
