import { describe, it, expect, vi, afterEach } from "vitest";
import express from "express";
import { StructuredLogger } from "@oneon/infrastructure";
import { loadEnv } from "../config/env.js";
import { createContainer } from "../container.js";
import { registerRoutes } from "./index.js";

function stubEnv(): void {
  vi.stubEnv("NEXTAUTH_SECRET", "test-secret");
  vi.stubEnv("ALLOWED_EMAILS", "alice@test.com");
  vi.stubEnv("API_TOKEN", "test-api-token");
  vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", "test-encryption-key-at-least-32-chars");
  vi.stubEnv("GOOGLE_CLIENT_ID", "test-client-id");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-client-secret");
  vi.stubEnv("GOOGLE_REFRESH_TOKEN", "");
  vi.stubEnv("DATABASE_PATH", ":memory:");
  vi.stubEnv("LOG_LEVEL", "error");
  vi.stubEnv("FEATURE_CHAT", "true");
}

describe("registerRoutes: chat calendar read tools", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("registers list_calendar_events and search_calendar on an OAuth-only deployment (no env-token calendar)", () => {
    stubEnv();
    const container = createContainer(loadEnv());
    try {
      expect(container.calendarPort).toBeNull();
      const info = vi.spyOn(StructuredLogger.prototype, "info");
      registerRoutes(express(), container);
      const registered = info.mock.calls.find(([message]) => message === "Chat route registered at /api/chat");
      expect(registered?.[1]?.tools).toEqual(expect.arrayContaining(["list_calendar_events", "search_calendar"]));
    } finally {
      container.shutdown();
    }
  });
});
