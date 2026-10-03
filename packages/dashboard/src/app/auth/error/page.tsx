"use client";

import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Suspense } from "react";
import { AlertTriangle } from "lucide-react";

function ErrorContent() {
  const params = useSearchParams();
  const error = params.get("error");

  const messages: Record<string, string> = {
    AccessDenied: "Your email is not in the authorized list.",
    Configuration: "Server configuration error. Contact the administrator.",
    Default: "An authentication error occurred.",
  };

  const message = messages[error ?? ""] ?? messages.Default;

  return (
    <div className="auth-shell motion-page-enter">
      <div className="auth-card state-content state-content-center motion-rise-in-soft">
        <AlertTriangle className="state-error-icon" />
        <div className="state-content state-content-center gap-1">
          <p className="page-eyebrow">Authentication</p>
          <h1 className="page-title">
            Access Denied
          </h1>
          <p className="state-subtext">
            {message}
          </p>
        </div>
        <Link
          href="/auth/signin"
          className="motion-interactive inline-flex items-center justify-center rounded-eight bg-primary px-6 py-2 text-sm font-medium text-on-primary hover:bg-primary/90"
        >
          Try again
        </Link>
      </div>
    </div>
  );
}

export default function AuthErrorPage() {
  return (
    <Suspense
      fallback={(
        <div className="auth-shell">
          <p className="state-subtext">Loading...</p>
        </div>
      )}
    >
      <ErrorContent />
    </Suspense>
  );
}
