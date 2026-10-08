import { beforeEach, describe, expect, it, vi } from "vitest";

const { auth, completeLink } = vi.hoisted(() => ({ auth: vi.fn(), completeLink: vi.fn() }));
vi.mock("../../../../lib/auth", () => ({ auth }));
vi.mock("../../../../lib/link-intent", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../../../lib/link-intent")>()), completeLink }));

import { DELETE, GET, PATCH, POST, PUT } from "./route";

const ID = "6f1c2c4e-7f0e-4c53-9a43-0f7b6c8f1a11";
const SECRET = "A".repeat(43);
const withIntent = `oneon-link-intent=${ID}.${SECRET}; authjs.session-token=abc`;
const request = (cookie: string | null = withIntent) =>
  new Request("https://oneon.example/auth/link/complete", { headers: cookie ? { cookie } : {} });
const location = (res: Response) => res.headers.get("location");
const cleared = (res: Response) => {
  const setCookie = res.headers.get("set-cookie") ?? "";
  return setCookie.includes("oneon-link-intent=;") && /Max-Age=0/i.test(setCookie) && /Path=\/auth\/link/i.test(setCookie);
};

describe("/auth/link/complete", () => {
  beforeEach(() => {
    auth.mockReset();
    completeLink.mockReset();
  });

  it.each([["POST", POST], ["PUT", PUT], ["PATCH", PATCH], ["DELETE", DELETE]])("rejects %s with 405", async (_method, handler) => {
    const res = await handler();
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });

  it("goes straight on to the dashboard when there is no link in progress", async () => {
    const res = await GET(request("authjs.session-token=abc"));

    expect(res.status).toBe(303);
    expect(location(res)).toBe("/");
    expect(auth).not.toHaveBeenCalled();
    expect(completeLink).not.toHaveBeenCalled();
  });

  it("asks for a sign-in, and keeps the intent, when there is no session to link", async () => {
    auth.mockResolvedValue(null);

    const res = await GET(request());

    expect(location(res)).toBe("/auth/signin");
    expect(completeLink).not.toHaveBeenCalled();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("links a Google sign-in with the intent from the cookie, then clears the cookie", async () => {
    auth.mockResolvedValue({ provider: "google", user: { sub: "g-sub", email: "a@b.com" } });
    completeLink.mockResolvedValue({ ok: true });

    const res = await GET(request());

    expect(completeLink).toHaveBeenCalledWith({ linkIntentId: ID, secret: SECRET }, { kind: "google", subject: "g-sub", email: "a@b.com" });
    expect(res.status).toBe(303);
    expect(location(res)).toBe("/");
    expect(cleared(res)).toBe(true);
  });

  it("links a hand-off sign-in by its identity", async () => {
    auth.mockResolvedValue({ provider: "impressorx", user: { sub: "identity-1" } });
    completeLink.mockResolvedValue({ ok: true });

    const res = await GET(request());

    expect(completeLink).toHaveBeenCalledWith({ linkIntentId: ID, secret: SECRET }, { kind: "impressorx", identityId: "identity-1" });
    expect(cleared(res)).toBe(true);
  });

  it.each(["link_expired", "link_conflict", "link_incomplete"])("sends a refused link (%s) to the error page and clears the cookie", async (reason) => {
    auth.mockResolvedValue({ provider: "google", user: { sub: "g-sub", email: "a@b.com" } });
    completeLink.mockResolvedValue({ ok: false, reason });

    const res = await GET(request());

    expect(location(res)).toBe(`/auth/error?reason=${reason}`);
    expect(cleared(res)).toBe(true);
  });
});
