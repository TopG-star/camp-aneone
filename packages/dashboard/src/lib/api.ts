import { PERSONAL_CONTEXT_MESSAGE, PERSONAL_CONTEXT_REQUIRED, isContextRefusal } from "./context";

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
    // A hand-off session is told by the server that Personal is not on offer for it; a Google session in a pharmacy can just switch.
    if (body.error === PERSONAL_CONTEXT_REQUIRED) {
      return typeof body.message === "string" && body.message.trim().length > 0 ? body.message : PERSONAL_CONTEXT_MESSAGE;
    }
    // A context that cannot open explains itself to the person (the code alone is not a message).
    if (typeof body.message === "string" && body.message.trim().length > 0 && (isContextRefusal(body.error) || body.error === "context_unavailable")) {
      return body.message;
    }
    if (typeof body.error === "string" && body.error.trim().length > 0) {
      const issues: string[] = Array.isArray(body.issues)
        ? body.issues.filter((i: unknown): i is string => typeof i === "string")
        : [];
      return issues.length > 0 ? `${body.error}: ${issues.join("; ")}` : body.error;
    }
    if (Array.isArray(body.errors)) {
      const fields: string[] = body.errors
        .filter((e: unknown): e is { field: string; message: string } =>
          typeof e === "object" && e !== null && typeof (e as { field?: unknown }).field === "string" && typeof (e as { message?: unknown }).message === "string")
        .map((e: { field: string; message: string }) => `${e.field}: ${e.message}`);
      if (fields.length > 0) return fields.join("; ");
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
    // A pharmacy that cannot open (stale details, switched off), or a personal-only route reached from one, is shown to
    // the person; signing in again would not help.
    const refusalCode = res.status === 403 ? ((await res.clone().json().catch(() => null)) as { error?: unknown } | null)?.error : undefined;
    const contextRefusal = isContextRefusal(refusalCode) || refusalCode === PERSONAL_CONTEXT_REQUIRED;
    if (!contextRefusal && (options?.redirectOnAuth !== false || res.status === 401)) {
      maybeRedirectToSignIn(res.status);
    }
    const message = await readErrorMessage(res);
    throw new ApiError(res.status, message);
  }

  return parseSuccessBody<T>(res);
}
