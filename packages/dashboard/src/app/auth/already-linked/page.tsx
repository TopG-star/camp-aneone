import Link from "next/link";
import { Link2 } from "lucide-react";

/** Shown when Confirm found nothing to link: both sign-ins were already the same account. The session is left as it was. */
export default function AlreadyLinkedPage() {
  return (
    <div className="auth-shell motion-page-enter">
      <div className="auth-card state-content state-content-center motion-rise-in-soft gap-6">
        <Link2 className="h-8 w-8" />
        <div className="state-content state-content-center gap-1">
          <p className="page-eyebrow">Linking</p>
          <h1 className="page-title">Already the same account</h1>
          <p className="state-subtext">These sign-ins already belong to the same Oneon account, so nothing was changed.</p>
        </div>
        <Link
          href="/"
          className="motion-interactive inline-flex items-center justify-center rounded-eight bg-primary px-6 py-2 text-sm font-medium text-on-primary hover:bg-primary/90"
        >
          Continue
        </Link>
      </div>
    </div>
  );
}
