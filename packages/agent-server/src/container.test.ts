import { describe, it, expect, vi, afterEach } from "vitest";
import { personalActor } from "@oneon/domain";
import { loadEnv } from "./config/env.js";
import { createContainer } from "./container.js";

vi.mock("google-auth-library", () => ({
  OAuth2Client: vi.fn().mockImplementation(() => ({
    setCredentials: vi.fn(),
    getAccessToken: vi.fn().mockRejectedValue(new Error("invalid_grant")),
  })),
}));

function stubEnv(): void {
  vi.stubEnv("NEXTAUTH_SECRET", "test-secret");
  vi.stubEnv("ALLOWED_EMAILS", "alice@test.com");
  vi.stubEnv("API_TOKEN", "test-api-token");
  vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", "test-encryption-key-at-least-32-chars");
  vi.stubEnv("GOOGLE_CLIENT_ID", "test-client-id");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-client-secret");
  vi.stubEnv("DATABASE_PATH", ":memory:");
  vi.stubEnv("LOG_LEVEL", "error");
}

describe("createContainer", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("records a Gmail refresh failure for the user whose Google token refresh fails", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-01T12:00:00.000Z"), toFake: ["Date"] });
    stubEnv();

    const container = createContainer(loadEnv());
    try {
      container.userRepo!.upsert({ id: "user-A", email: "alice@test.com" });
      container.oauthTokenRepo!.upsert({
        provider: "google",
        userId: "user-A",
        accessToken: "ya29.expired-access",
        refreshToken: "1//revoked-refresh",
        tokenType: "bearer",
        scope: "openid email",
        expiresAt: "2026-10-01T11:00:00.000Z",
        providerEmail: "alice@test.com",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
      });

      const provider = container.createGoogleTokenProvider("user-A");
      await expect(provider!.getAccessToken()).rejects.toThrow("invalid_grant");

      expect(container.preferenceRepo.get("gmail_last_refresh_failure_at:user-A")).toBe(
        "2026-10-01T12:00:00.000Z",
      );
    } finally {
      container.shutdown();
    }
  });

  it("delivers exactly one in-app notification for a notify action", async () => {
    stubEnv();
    const container = createContainer(loadEnv());
    try {
      container.userRepo!.upsert({ id: "user-A", email: "alice@test.com" });
      const outcome = await container.actions.orchestrator.requestAction({
        type: "notify",
        input: { inboundItemId: "i1", title: "Urgent: Q4", body: "Needs numbers", deepLink: "/items/i1" },
        actor: personalActor("user-A"),
        initiator: "rule:inbox.urgent_notify",
        keyContext: { source: "rule", resourceId: "i1" },
        evidence: [],
        resourceRef: "inbound_item:i1",
      });
      expect(outcome).toMatchObject({ kind: "created", instance: { status: "completed" } });
      expect(container.notificationRepo.findAll({ userId: "user-A" })).toHaveLength(1);
    } finally {
      container.shutdown();
    }
  });

  it("gives executors a calendar writer only for users with a Google token", () => {
    stubEnv();
    const container = createContainer(loadEnv());
    try {
      container.userRepo!.upsert({ id: "user-A", email: "alice@test.com" });
      container.userRepo!.upsert({ id: "user-B", email: "bob@test.com" });
      container.oauthTokenRepo!.upsert({
        provider: "google",
        userId: "user-A",
        accessToken: "a",
        refreshToken: "r",
        tokenType: "bearer",
        scope: "openid email",
        expiresAt: "2099-01-01T00:00:00.000Z",
        providerEmail: "alice@test.com",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
      });
      expect(container.actions.capabilitiesFor("user-A").writers.calendar).not.toBeNull();
      expect(container.actions.capabilitiesFor("user-A").readers.identity.googleEmail).toBe("alice@test.com");
      expect(container.actions.capabilitiesFor("user-B").writers.calendar).toBeNull();
    } finally {
      container.shutdown();
    }
  });
});
