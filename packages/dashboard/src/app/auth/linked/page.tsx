"use client";

import { signIn } from "next-auth/react";
import { Link2, Mail } from "lucide-react";

/** Shown after a link is committed; the session that made it has been ended, so the way back in is a fresh sign-in. */
export default function LinkedPage() {
  return (
    <div className="auth-shell motion-page-enter">
      <div className="auth-card state-content state-content-center motion-rise-in-soft gap-6">
        <Link2 className="h-8 w-8" />
        <div className="state-content state-content-center gap-1">
          <p className="page-eyebrow">Linking</p>
          <h1 className="page-title">Your accounts are linked</h1>
          <p className="state-subtext">Your accounts are linked. Sign in again to continue.</p>
        </div>
        <button
          onClick={() => signIn("google", { callbackUrl: "/" })}
          className="flex w-full items-center justify-center gap-3 rounded-twelve border border-outline/20 bg-surface-low px-6 py-3 text-sm font-medium text-on-surface transition-colors hover:bg-surface-low/80 dark:border-dark-outline/20 dark:bg-dark-surface-low dark:text-dark-on-surface dark:hover:bg-dark-surface-low/80"
        >
          <Mail className="h-5 w-5" />
          Sign in with Google
        </button>
        <p className="state-subtext">Or open Oneon from ImpressoRx again to work in your pharmacy.</p>
      </div>
    </div>
  );
}
