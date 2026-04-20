"use client";

import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Suspense } from "react";

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
    <div className="flex min-h-screen items-center justify-center bg-surface dark:bg-dark-surface">
      <div className="w-full max-w-sm space-y-6 text-center">
        <div className="space-y-2">
          <h1 className="text-display-md font-bold text-red-400">
            Access Denied
          </h1>
          <p className="text-body-md text-on-surface-variant dark:text-dark-on-surface-variant">
            {message}
          </p>
        </div>
        <Link
          href="/auth/signin"
          className="inline-block rounded-eight bg-primary px-6 py-2 text-sm font-medium text-on-primary hover:bg-primary/90"
        >
          Try again
        </Link>
      </div>
    </div>
  );
}

export default function AuthErrorPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center">Loading...</div>}>
      <ErrorContent />
    </Suspense>
  );
}
