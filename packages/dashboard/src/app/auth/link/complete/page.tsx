import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertTriangle, Link2 } from "lucide-react";
import { loadLinkConfirmation } from "@/lib/link-confirm";
import { LINK_SCOPE_NOTE } from "@/lib/link-account";
import { LINK_MESSAGES } from "@/lib/link-messages";

// Reads the person's cookies on every request.
export const dynamic = "force-dynamic";

const primary =
  "motion-interactive inline-flex items-center justify-center rounded-eight bg-primary px-6 py-2 text-sm font-medium text-on-primary hover:bg-primary/90";
const secondary =
  "motion-interactive inline-flex items-center justify-center rounded-eight border border-outline/20 px-6 py-2 text-sm font-medium text-on-surface hover:bg-surface-low dark:border-dark-outline/20 dark:text-dark-on-surface dark:hover:bg-dark-surface-low";

/**
 * Where both second sign-ins of a link land (spec §4.5). It only asks; nothing is linked by opening it. The link is made by
 * Confirm, a same-origin POST to /auth/link/confirm, so a page, a redirect or a stray tab on a shared browser cannot merge two
 * people's accounts. Cancel forgets the pending link.
 */
export default async function LinkCompletePage() {
  const state = await loadLinkConfirmation((await cookies()).toString());
  if (state.state === "none") redirect("/");
  if (state.state === "signin") redirect("/auth/signin");

  if (state.state === "refused") {
    return (
      <div className="auth-shell motion-page-enter">
        <div className="auth-card state-content state-content-center motion-rise-in-soft">
          <AlertTriangle className="state-error-icon" />
          <div className="state-content state-content-center gap-1">
            <p className="page-eyebrow">Linking</p>
            <h1 className="page-title">Can&apos;t link accounts</h1>
            <p className="state-subtext">{LINK_MESSAGES[state.reason]}</p>
          </div>
          <Link href="/settings" className={primary}>
            Back to Settings
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-shell motion-page-enter">
      <div className="auth-card state-content state-content-center motion-rise-in-soft gap-6">
        <Link2 className="h-8 w-8" />
        <div className="state-content state-content-center gap-1">
          <p className="page-eyebrow">Linking</p>
          <h1 className="page-title">{state.question}</h1>
          <p className="state-subtext">You&apos;ll be signed out afterwards and asked to sign in again.</p>
          <p className="state-subtext">{LINK_SCOPE_NOTE}</p>
        </div>
        <div className="flex gap-3">
          <form method="post" action="/auth/link/confirm">
            <input type="hidden" name="csrf" value={state.csrf} />
            <button type="submit" className={primary}>
              Confirm
            </button>
          </form>
          <form method="post" action="/auth/link/cancel">
            <button type="submit" className={secondary}>
              Cancel
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
