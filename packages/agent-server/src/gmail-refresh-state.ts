import type { PreferenceRepository } from "@oneon/domain";

/** Preference key recording when the user's last Gmail token refresh failed. */
export function gmailLastRefreshFailureAtKey(userId: string): string {
  return `gmail_last_refresh_failure_at:${userId}`;
}

/** Marks the user's Gmail token refresh as failed now; cleared on reconnect or disconnect. */
export function recordGmailRefreshFailure(
  preferenceRepo: PreferenceRepository,
  userId: string,
): void {
  preferenceRepo.set(gmailLastRefreshFailureAtKey(userId), new Date().toISOString());
}
