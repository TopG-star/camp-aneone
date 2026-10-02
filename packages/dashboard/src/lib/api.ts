const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function shouldAttemptJson(contentType: string | null): boolean {
  return contentType?.toLowerCase().includes("application/json") ?? false;
}

async function readErrorMessage(res: Response): Promise<string> {
  const contentType = res.headers.get("content-type");

  if (shouldAttemptJson(contentType)) {
    const body = await res.json().catch(() => ({}));
    if (typeof body.error === "string" && body.error.trim().length > 0) {
      const issues: string[] = Array.isArray(body.issues)
        ? body.issues.filter((i: unknown): i is string => typeof i === "string")
        : [];
      return issues.length > 0 ? `${body.error}: ${issues.join("; ")}` : body.error;
    }
  }

  const text = await res.text().catch(() => "");
  const trimmed = text.trim();
  if (trimmed.length > 0) {
    return trimmed;
  }

  return res.statusText || "Request failed";
}

async function parseSuccessBody<T>(res: Response): Promise<T> {
  if (res.status === 204) {
    return null as T;
  }

  const contentType = res.headers.get("content-type");
  if (shouldAttemptJson(contentType)) {
    return res.json() as Promise<T>;
  }

  const text = await res.text();
  return text as T;
}

function maybeRedirectToSignIn(status: number): void {
  if (status !== 401 && status !== 403) {
    return;
  }
  if (typeof window === "undefined") {
    return;
  }
  if (window.location.pathname.startsWith("/auth/")) {
    return;
  }

  const callbackUrl = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/auth/signin?callbackUrl=${encodeURIComponent(callbackUrl)}`);
}

/**
 * Fetch wrapper for dashboard → agent-server API calls.
 *
 * Auth relies on the session cookie forwarded by Next.js rewrite proxy
 * (same-origin, so `credentials: "include"` ensures the browser sends the
 * NextAuth session cookie). No Bearer token is sent from the browser.
 */
export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
  options?: { redirectOnAuth?: boolean },
): Promise<T> {
  const url = `${API_BASE}${path}`;
  const headers: HeadersInit = {
    "Content-Type": "application/json",
    ...init?.headers,
  };

  const res = await fetch(url, { ...init, headers, credentials: "include" });

  if (!res.ok) {
    if (options?.redirectOnAuth !== false || res.status === 401) {
      maybeRedirectToSignIn(res.status);
    }
    const message = await readErrorMessage(res);
    throw new ApiError(res.status, message);
  }

  return parseSuccessBody<T>(res);
}
