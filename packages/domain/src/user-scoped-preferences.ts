import type { Preference } from "./entities.js";
import type { PreferenceRepository } from "./ports/preference-repository.port.js";

const USER_KEY_PREFIX = "user:";

export function toUserScopedPreferenceKey(userId: string, key: string): string {
  return `${USER_KEY_PREFIX}${userId}:${key}`;
}

export function getUserScopedPreference(
  preferenceRepo: PreferenceRepository,
  userId: string,
  key: string,
): string | null {
  const scopedValue = preferenceRepo.get(toUserScopedPreferenceKey(userId, key));
  if (scopedValue !== null) {
    return scopedValue;
  }

  return preferenceRepo.get(key);
}

export function setUserScopedPreference(
  preferenceRepo: PreferenceRepository,
  userId: string,
  key: string,
  value: string,
): Preference {
  return preferenceRepo.set(toUserScopedPreferenceKey(userId, key), value);
}

export function listUserScopedPreferencesByPrefix(
  preferenceRepo: PreferenceRepository,
  userId: string,
  prefix: string,
): Record<string, string> {
  const userPrefix = `${USER_KEY_PREFIX}${userId}:${prefix}`;
  const stripPrefix = `${USER_KEY_PREFIX}${userId}:`;

  const preferences: Record<string, string> = {};
  for (const entry of preferenceRepo.getAll()) {
    if (!entry.key.startsWith(userPrefix)) {
      continue;
    }

    const clientKey = entry.key.slice(stripPrefix.length);
    preferences[clientKey] = entry.value;
  }

  return preferences;
}
