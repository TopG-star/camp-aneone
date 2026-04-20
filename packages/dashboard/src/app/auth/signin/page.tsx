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
    <div className="flex min-h-screen items-center justify-center bg-surface dark:bg-dark-surface">
      <div className="w-full max-w-sm space-y-8 text-center">
        <div className="space-y-2">
          <h1 className="text-display-lg font-bold text-on-surface dark:text-dark-on-surface">
            Oneon
          </h1>
          <p className="text-body-lg text-on-surface-variant dark:text-dark-on-surface-variant">
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

        <p className="text-label-sm text-on-surface-variant/50 dark:text-dark-on-surface-variant/50">
          Access is restricted to authorized users.
        </p>
      </div>
    </div>
  );
}
