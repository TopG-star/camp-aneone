/** Preference key recording when the user's last Gmail token refresh failed. */
export function gmailLastRefreshFailureAtKey(userId: string): string {
  return `gmail_last_refresh_failure_at:${userId}`;
}
