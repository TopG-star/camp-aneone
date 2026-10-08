/** A Google account may sign in only with a verified email that is on the allow-list. */
export function isSignInAllowed(
  profile: { email?: string | null; email_verified?: boolean | null } | null | undefined,
  allowedEmails: string[],
): boolean {
  const email = profile?.email?.toLowerCase();
  return Boolean(email) && profile?.email_verified === true && allowedEmails.includes(email as string);
}
