"use client";

import { signIn } from "next-auth/react";
import { Mail, Loader2 } from "lucide-react";
import { useState } from "react";

export default function SignInPage() {
  const [loading, setLoading] = useState(false);

  function handleSignIn() {
    setLoading(true);
    signIn("google", { callbackUrl: "/" });
  }

  return (
    <div className="auth-shell motion-page-enter">
      <div className="auth-card state-content state-content-center motion-rise-in-soft gap-6">
        <div className="state-content state-content-center gap-1">
          <p className="page-eyebrow">Secure Access</p>
          <h1 className="page-title">
            Oneon
          </h1>
          <p className="state-subtext">
            Your personal AI agent
          </p>
        </div>

        <button
          onClick={handleSignIn}
          disabled={loading}
          className="flex w-full items-center justify-center gap-3 rounded-twelve border border-outline/20 bg-surface-low px-6 py-3 text-sm font-medium text-on-surface transition-colors hover:bg-surface-low/80 disabled:opacity-50 dark:border-dark-outline/20 dark:bg-dark-surface-low dark:text-dark-on-surface dark:hover:bg-dark-surface-low/80"
        >
          {loading ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <Mail className="h-5 w-5" />
          )}
          Sign in with Google
        </button>

        <p className="state-subtext">
          Access is restricted to authorized users.
        </p>
      </div>
    </div>
  );
}
