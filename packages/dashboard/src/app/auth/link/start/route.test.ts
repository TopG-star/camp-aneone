import { beforeEach, describe, expect, it, vi } from "vitest";

const { startLinkIntent } = vi.hoisted(() => ({ startLinkIntent: vi.fn() }));
vi.mock("../../../../lib/link-intent", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../../../lib/link-intent")>()), startLinkIntent }));

import { DELETE, GET, PATCH, POST, PUT } from "./route";

const ID = "6f1c2c4e-7f0e-4c53-9a43-0f7b6c8f1a11";
const SECRET = "A".repeat(43);
const request = (cookie = "authjs.session-token=abc; theme=dark") =>
  new Request("https://oneon.example/auth/link/start", { method: "POST", headers: cookie ? { cookie } : {} });

describe("/auth/link/start", () => {
  beforeEach(() => startLinkIntent.mockReset());

  it.each([["GET", GET], ["PUT", PUT], ["PATCH", PATCH], ["DELETE", DELETE]])("rejects %s with 405", async (_method, handler) => {
    const res = await handler();
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(startLinkIntent).not.toHaveBeenCalled();
  });

  it("opens the intent with the person's session cookie and keeps its secret in a 5-minute HttpOnly SameSite=Lax cookie, out of the body", async () => {
    startLinkIntent.mockResolvedValue({ ok: true, intent: { linkIntentId: ID, secret: SECRET }, next: "google" });

    const res = await POST(request());

    expect(startLinkIntent).toHaveBeenCalledWith(expect.objectContaining({ cookieHeader: "authjs.session-token=abc; theme=dark", sessionCookieName: "authjs.session-token", secure: false }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ next: "google" });
    expect(JSON.stringify(body)).not.toContain(SECRET);
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toContain(`oneon-link-intent=${ID}.${SECRET}`);
    expect(setCookie).toMatch(/Max-Age=300/i);
    expect(setCookie).toMatch(/Path=\/auth\/link/i);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=lax/i);
  });

  it("passes on a refusal or an unreachable agent-server and sets no cookie", async () => {
    startLinkIntent.mockResolvedValueOnce({ ok: false, status: 401 });
    const refused = await POST(request());
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: "link_unavailable" });
    expect(refused.headers.get("set-cookie")).toBeNull();

    startLinkIntent.mockResolvedValueOnce({ ok: false, status: 502 });
    expect((await POST(request())).status).toBe(502);
  });
});
