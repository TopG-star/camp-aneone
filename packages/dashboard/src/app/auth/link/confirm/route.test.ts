import { beforeEach, describe, expect, it, vi } from "vitest";

const { signOut, completeLink, readSealedSession } = vi.hoisted(() => ({ signOut: vi.fn(), completeLink: vi.fn(), readSealedSession: vi.fn() }));
vi.mock("../../../../lib/auth", () => ({ signOut }));
vi.mock("../../../../lib/link-intent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/link-intent")>()),
  completeLink,
  readSealedSession,
}));

import { linkCsrfToken } from "../../../../lib/link-intent";
import { DELETE, GET, PATCH, POST, PUT } from "./route";

const ID = "6f1c2c4e-7f0e-4c53-9a43-0f7b6c8f1a11";
const SECRET = "A".repeat(43);
const INTENT = { linkIntentId: ID, secret: SECRET };
const GOOD_TOKEN = linkCsrfToken(INTENT);

function confirm({
  origin = "https://oneon.example" as string | null,
  csrf = GOOD_TOKEN as string | null,
  cookie = `oneon-link-intent=${ID}.${SECRET}; authjs.session-token=abc`,
} = {}) {
  const headers: Record<string, string> = { cookie };
  if (origin) headers.origin = origin;
  const body = new URLSearchParams(csrf === null ? {} : { csrf });
  return new Request("https://oneon.example/auth/link/confirm", { method: "POST", headers, body });
}
const location = (res: Response) => res.headers.get("location");
const cleared = (res: Response) => {
  const setCookie = res.headers.get("set-cookie") ?? "";
  return setCookie.includes("oneon-link-intent=;") && /Max-Age=0/i.test(setCookie) && /Path=\/auth\/link/i.test(setCookie);
};

describe("/auth/link/confirm", () => {
  beforeEach(() => {
    signOut.mockReset();
    completeLink.mockReset();
    readSealedSession.mockReset();
    readSealedSession.mockResolvedValue({ provider: "google", sub: "g-sub", email: "gerry@x.com" });
  });

  it.each([["GET", GET], ["PUT", PUT], ["PATCH", PATCH], ["DELETE", DELETE]])("rejects %s with 405: the link is only ever committed by a POST", async (_method, handler) => {
    const res = await handler();
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(completeLink).not.toHaveBeenCalled();
  });

  it("refuses a cross-origin POST, even with the right token, and links nothing", async () => {
    const res = await POST(confirm({ origin: "https://evil.example" }));

    expect(res.status).toBe(403);
    expect(completeLink).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("refuses a POST that carries no Origin", async () => {
    expect((await POST(confirm({ origin: null }))).status).toBe(403);
    expect(completeLink).not.toHaveBeenCalled();
  });

  it("refuses a POST without the token, with the wrong one, or with another intent's", async () => {
    for (const csrf of [null, "", "wrong", linkCsrfToken({ linkIntentId: ID, secret: "B".repeat(43) })]) {
      const res = await POST(confirm({ csrf }));
      expect(res.status).toBe(403);
    }
    expect(completeLink).not.toHaveBeenCalled();
  });

  it("goes straight on when there is no link in progress", async () => {
    const res = await POST(confirm({ cookie: "authjs.session-token=abc" }));

    expect(res.status).toBe(303);
    expect(location(res)).toBe("/");
    expect(completeLink).not.toHaveBeenCalled();
  });

  it("asks for a sign-in, and keeps the intent, when there is no session", async () => {
    readSealedSession.mockResolvedValue(null);

    const res = await POST(confirm());

    expect(location(res)).toBe("/auth/signin");
    expect(completeLink).not.toHaveBeenCalled();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("commits a Google sign-in, clears the intent cookie, ends the session and shows the linked page", async () => {
    completeLink.mockResolvedValue({ ok: true });

    const res = await POST(confirm());

    expect(completeLink).toHaveBeenCalledWith(INTENT, { kind: "google", subject: "g-sub", email: "gerry@x.com" });
    expect(signOut).toHaveBeenCalledWith({ redirect: false });
    expect(res.status).toBe(303);
    expect(location(res)).toBe("/auth/linked");
    expect(cleared(res)).toBe(true);
  });

  it("commits a hand-off with the session id and membership from the sealed session", async () => {
    readSealedSession.mockResolvedValue({ provider: "impressorx", sub: "i-1", identityId: "i-1", sessionId: "s-1", membershipId: "m-1" });
    completeLink.mockResolvedValue({ ok: true });

    await POST(confirm());

    expect(completeLink).toHaveBeenCalledWith(INTENT, { kind: "impressorx", identityId: "i-1", sessionId: "s-1", membershipId: "m-1" });
  });

  it("still shows the linked page when ending the session fails", async () => {
    completeLink.mockResolvedValue({ ok: true });
    signOut.mockRejectedValue(new Error("no request"));

    const res = await POST(confirm());

    expect(location(res)).toBe("/auth/linked");
    expect(cleared(res)).toBe(true);
  });

  it.each(["link_expired", "link_conflict", "link_needs_google", "link_account_disabled", "link_unavailable", "link_incomplete", "link_outcome_unknown"])(
    "sends a refused link (%s) to the error page, clears the cookie and keeps the session",
    async (reason) => {
      completeLink.mockResolvedValue({ ok: false, reason });

      const res = await POST(confirm());

      expect(location(res)).toBe(`/auth/error?reason=${reason}`);
      expect(cleared(res)).toBe(true);
      expect(signOut).not.toHaveBeenCalled();
    },
  );
});
