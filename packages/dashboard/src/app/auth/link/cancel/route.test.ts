import { beforeEach, describe, expect, it, vi } from "vitest";

const { completeLink, previewLink } = vi.hoisted(() => ({ completeLink: vi.fn(), previewLink: vi.fn() }));
vi.mock("../../../../lib/link-intent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/link-intent")>()),
  completeLink,
  previewLink,
}));

import { DELETE, GET, PATCH, POST, PUT } from "./route";

const ID = "6f1c2c4e-7f0e-4c53-9a43-0f7b6c8f1a11";
const SECRET = "A".repeat(43);

const cancel = (origin: string | null = "https://oneon.example") =>
  new Request("https://oneon.example/auth/link/cancel", {
    method: "POST",
    headers: { cookie: `oneon-link-intent=${ID}.${SECRET}`, ...(origin ? { origin } : {}) },
  });

describe("/auth/link/cancel", () => {
  beforeEach(() => {
    completeLink.mockReset();
    previewLink.mockReset();
  });

  it.each([["GET", GET], ["PUT", PUT], ["PATCH", PATCH], ["DELETE", DELETE]])("rejects %s with 405", async (_method, handler) => {
    expect((await handler()).status).toBe(405);
  });

  it("clears the intent cookie and consumes nothing: no call reaches the agent-server", async () => {
    const res = await POST(cancel());

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("oneon-link-intent=;");
    expect(setCookie).toMatch(/Max-Age=0/i);
    expect(setCookie).toMatch(/Path=\/auth\/link/i);
    expect(completeLink).not.toHaveBeenCalled();
    expect(previewLink).not.toHaveBeenCalled();
  });

  it("leaves the cookie alone for a cross-origin POST", async () => {
    const res = await POST(cancel("https://evil.example"));

    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
