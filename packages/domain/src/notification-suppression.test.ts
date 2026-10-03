import { describe, it, expect } from "vitest";
import type { PreferenceRepository, Preference } from "./index.js";
import { evaluateNotificationSuppression } from "./notification-suppression.js";

function prefs(values: Record<string, string>): PreferenceRepository {
  return {
    get: (key) => values[key] ?? null,
    set: (key, value) => {
      values[key] = value;
      return { key, value, updatedAt: "2026-10-01T00:00:00.000Z" } as Preference;
    },
    getAll: () => [],
    delete: (key) => {
      delete values[key];
    },
  };
}

// 2026-10-01T23:30:00Z is 23:30 in UTC.
const LATE = new Date("2026-10-01T23:30:00.000Z");
const NOON = new Date("2026-10-01T12:00:00.000Z");

describe("evaluateNotificationSuppression", () => {
  it("returns type_disabled when the user turned the event type off", () => {
    const repo = prefs({ "user:u1:notification.enabled.urgent_item": "false" });
    expect(evaluateNotificationSuppression(repo, "u1", "urgent_item", NOON)).toBe("type_disabled");
  });

  it("returns quiet_hours inside an overnight window in the user's timezone", () => {
    const repo = prefs({
      "user:u1:notification.quiet_hours": JSON.stringify({ start: "22:00", end: "07:00" }),
      "user:u1:notification.timezone": "UTC",
    });
    expect(evaluateNotificationSuppression(repo, "u1", "urgent_item", LATE)).toBe("quiet_hours");
  });

  it("returns null outside quiet hours", () => {
    const repo = prefs({
      "user:u1:notification.quiet_hours": JSON.stringify({ start: "22:00", end: "07:00" }),
      "user:u1:notification.timezone": "UTC",
    });
    expect(evaluateNotificationSuppression(repo, "u1", "urgent_item", NOON)).toBeNull();
  });

  it("ignores malformed quiet hours and reports it", () => {
    const repo = prefs({ "user:u1:notification.quiet_hours": "not json" });
    const reported: string[] = [];
    expect(
      evaluateNotificationSuppression(repo, "u1", "urgent_item", NOON, (m) => reported.push(m)),
    ).toBeNull();
    expect(reported).toEqual(["Invalid quiet hours preference, ignoring"]);
  });
});
