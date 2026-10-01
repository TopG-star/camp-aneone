import type { PreferenceRepository } from "./ports/preference-repository.port.js";
import type { SuppressionReason } from "./actions/capabilities.js";
import { getUserScopedPreference } from "./user-scoped-preferences.js";

type Report = (message: string, meta: Record<string, unknown>) => void;

function read(prefs: PreferenceRepository, userId: string | null, key: string): string | null {
  return userId ? getUserScopedPreference(prefs, userId, key) : prefs.get(key);
}

/**
 * Shared by the in-app adapter and notify's precondition, so they cannot disagree.
 * Type toggle: `notification.enabled.<eventType>` ("false" disables; default enabled).
 * Quiet hours: `notification.quiet_hours` = {"start":"HH:mm","end":"HH:mm"}, evaluated in
 * `notification.timezone`, falling back to server-local time.
 */
export function evaluateNotificationSuppression(
  prefs: PreferenceRepository,
  userId: string | null,
  eventType: string,
  now: Date,
  onInvalid: Report = () => {},
): SuppressionReason | null {
  if (read(prefs, userId, `notification.enabled.${eventType}`) === "false") {
    return "type_disabled";
  }
  return isQuietHours(prefs, userId, now, onInvalid) ? "quiet_hours" : null;
}

function isQuietHours(prefs: PreferenceRepository, userId: string | null, now: Date, onInvalid: Report): boolean {
  const quietHoursJson = read(prefs, userId, "notification.quiet_hours");
  if (!quietHoursJson) return false;

  try {
    const { start, end } = JSON.parse(quietHoursJson) as { start?: string; end?: string };
    if (!start || !end) return false;

    const tz = read(prefs, userId, "notification.timezone");
    let currentMinutes: number;
    if (tz) {
      try {
        const parts = new Intl.DateTimeFormat("en-US", {
          timeZone: tz,
          hour: "numeric",
          minute: "numeric",
          hour12: false,
        }).formatToParts(now);
        const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
        const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
        currentMinutes = hour * 60 + minute;
      } catch {
        onInvalid("Invalid notification.timezone, falling back to server time", { timezone: tz });
        currentMinutes = now.getHours() * 60 + now.getMinutes();
      }
    } else {
      currentMinutes = now.getHours() * 60 + now.getMinutes();
    }

    const [startH, startM] = start.split(":").map(Number);
    const [endH, endM] = end.split(":").map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    if (startMinutes <= endMinutes) {
      return currentMinutes >= startMinutes && currentMinutes < endMinutes;
    }
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  } catch {
    onInvalid("Invalid quiet hours preference, ignoring", { raw: quietHoursJson });
    return false;
  }
}
