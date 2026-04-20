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
): Promise<T> {
  const url = `${API_BASE}${path}`;
  const headers: HeadersInit = {
    "Content-Type": "application/json",
    ...init?.headers,
  };

  const res = await fetch(url, { ...init, headers, credentials: "include" });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error ?? res.statusText);
  }

  return res.json() as Promise<T>;
}
