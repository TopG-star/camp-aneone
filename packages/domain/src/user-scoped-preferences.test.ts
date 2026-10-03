import { describe, expect, it, vi } from "vitest";
import type { PreferenceRepository } from "./ports/preference-repository.port.js";
import {
  getUserScopedPreference,
  listUserScopedPreferencesByPrefix,
  setUserScopedPreference,
  toUserScopedPreferenceKey,
} from "./user-scoped-preferences.js";

function createMockPreferenceRepo(
  overrides: Partial<PreferenceRepository> = {},
): PreferenceRepository {
  return {
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
    getAll: vi.fn().mockReturnValue([]),
    delete: vi.fn(),
    ...overrides,
  };
}

describe("user-scoped preferences helper", () => {
  it("builds namespaced preference keys", () => {
    expect(toUserScopedPreferenceKey("user-1", "notification.quiet_hours")).toBe(
      "user:user-1:notification.quiet_hours",
    );
  });

  it("reads a user-scoped value before global fallback", () => {
    const repo = createMockPreferenceRepo({
      get: vi.fn().mockImplementation((key: string) =>
        key === "user:user-1:notification.quiet_hours"
          ? '{"start":"22:00","end":"07:00"}'
          : null,
      ),
    });

    const value = getUserScopedPreference(
      repo,
      "user-1",
      "notification.quiet_hours",
    );

    expect(value).toBe('{"start":"22:00","end":"07:00"}');
    expect(repo.get).toHaveBeenCalledWith("user:user-1:notification.quiet_hours");
  });

  it("falls back to global preference when scoped value is missing", () => {
    const repo = createMockPreferenceRepo({
      get: vi.fn().mockImplementation((key: string) =>
        key === "notification.timezone" ? "America/New_York" : null,
      ),
    });

    const value = getUserScopedPreference(repo, "user-1", "notification.timezone");

    expect(value).toBe("America/New_York");
    expect(repo.get).toHaveBeenNthCalledWith(
      1,
      "user:user-1:notification.timezone",
    );
    expect(repo.get).toHaveBeenNthCalledWith(2, "notification.timezone");
  });

  it("writes using the user-scoped key", () => {
    const repo = createMockPreferenceRepo({
      set: vi.fn().mockReturnValue({
        key: "user:user-1:notification.enabled.urgent_item",
        value: "false",
        updatedAt: "2026-04-18T10:00:00Z",
      }),
    });

    setUserScopedPreference(
      repo,
      "user-1",
      "notification.enabled.urgent_item",
      "false",
    );

    expect(repo.set).toHaveBeenCalledWith(
      "user:user-1:notification.enabled.urgent_item",
      "false",
    );
  });

  it("lists user-scoped preferences under a prefix", () => {
    const repo = createMockPreferenceRepo({
      getAll: vi.fn().mockReturnValue([
        {
          key: "user:user-1:notification.enabled.urgent_item",
          value: "false",
          updatedAt: "2026-04-18T10:00:00Z",
        },
        {
          key: "user:user-1:notification.quiet_hours",
          value: '{"start":"22:00","end":"07:00"}',
          updatedAt: "2026-04-18T10:00:00Z",
        },
        {
          key: "user:user-2:notification.enabled.urgent_item",
          value: "true",
          updatedAt: "2026-04-18T10:00:00Z",
        },
      ]),
    });

    const result = listUserScopedPreferencesByPrefix(
      repo,
      "user-1",
      "notification.",
    );

    expect(result).toEqual({
      "notification.enabled.urgent_item": "false",
      "notification.quiet_hours": '{"start":"22:00","end":"07:00"}',
    });
  });
});
