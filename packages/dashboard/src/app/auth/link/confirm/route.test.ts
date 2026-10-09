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
// The sessions the page can have previewed, and so the tokens its Confirm button can carry.
const GERRY = { provider: "google", sub: "g-sub", email: "gerry@x.com" } as const;
const BOB = { provider: "impressorx", sub: "bob-identity", identityId: "bob-identity", sessionId: "bob-session", membershipId: "bob-m" } as const;
const CAROL = { provider: "impressorx", sub: "carol-identity", identityId: "carol-identity", sessionId: "carol-session", membershipId: "carol-m" } as const;
const tokenFor = (session: typeof GERRY | typeof BOB | typeof CAROL) =>
  linkCsrfToken(
    INTENT,
    session.provider === "google"
      ? { kind: "google", subject: session.sub, email: session.email }
      : { kind: "impressorx", identityId: session.identityId, sessionId: session.sessionId, membershipId: session.membershipId },
  );
const GOOD_TOKEN = tokenFor(GERRY);

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
    readSealedSession.mockResolvedValue(GERRY);
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

  it("refuses a POST without the token, with a wrong one, or with another intent's, and sends the person back to the question", async () => {
    for (const csrf of [null, "", "wrong", linkCsrfToken({ linkIntentId: ID, secret: "B".repeat(43) }, { kind: "google", subject: "g-sub", email: "gerry@x.com" })]) {
      const res = await POST(confirm({ csrf }));
      expect(res.status).toBe(303);
      expect(location(res)).toBe("/auth/link/complete");
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    expect(completeLink).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });

  // The page previewed one login; whoever is signed in when Confirm arrives is what would be linked. The token carries the
  // previewed login, so a different one is refused and the person is shown the current pairing instead. Nothing is spent.
  it.each([
    ["a hand-off previewed, then Carol's hand-off replaces the session in another tab", BOB, CAROL],
    ["a hand-off previewed, then a Google sign-in lands", BOB, GERRY],
    ["a Google sign-in previewed, then a hand-off lands", GERRY, BOB],
    ["a Google sign-in previewed, then another Google account signs in", GERRY, { ...GERRY, sub: "someone-elses-sub" }],
  ])("refuses and re-previews when the session changed between the question and Confirm: %s", async (_name, previewed, now) => {
    readSealedSession.mockResolvedValue(now);

    const res = await POST(confirm({ csrf: tokenFor(previewed) }));

    expect(res.status).toBe(303);
    expect(location(res)).toBe("/auth/link/complete");
    expect(completeLink).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    // The intent is neither spent nor forgotten: the page now shows the current pairing, and the person can still decide.
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("commits when the session is still the one that was previewed", async () => {
    readSealedSession.mockResolvedValue(CAROL);
    completeLink.mockResolvedValue({ ok: true, alreadyLinked: false });

    const res = await POST(confirm({ csrf: tokenFor(CAROL) }));

    expect(location(res)).toBe("/auth/linked");
    expect(completeLink).toHaveBeenCalledWith(INTENT, { kind: "impressorx", identityId: "carol-identity", sessionId: "carol-session", membershipId: "carol-m" });
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
    completeLink.mockResolvedValue({ ok: true, alreadyLinked: false });

    const res = await POST(confirm());

    expect(completeLink).toHaveBeenCalledWith(INTENT, { kind: "google", subject: "g-sub", email: "gerry@x.com" });
    expect(signOut).toHaveBeenCalledWith({ redirect: false });
    expect(res.status).toBe(303);
    expect(location(res)).toBe("/auth/linked");
    expect(cleared(res)).toBe(true);
  });

  it("commits a hand-off with the session id and membership from the sealed session", async () => {
    readSealedSession.mockResolvedValue(BOB);
    completeLink.mockResolvedValue({ ok: true, alreadyLinked: false });

    await POST(confirm({ csrf: tokenFor(BOB) }));

    expect(completeLink).toHaveBeenCalledWith(INTENT, { kind: "impressorx", identityId: "bob-identity", sessionId: "bob-session", membershipId: "bob-m" });
  });

  it("when there was nothing to link, says so, keeps the session and does not claim the accounts were linked", async () => {
    completeLink.mockResolvedValue({ ok: true, alreadyLinked: true });

    const res = await POST(confirm());

    expect(res.status).toBe(303);
    expect(location(res)).toBe("/auth/already-linked");
    expect(signOut).not.toHaveBeenCalled();
    expect(cleared(res)).toBe(true);
  });

  it("still shows the linked page when ending the session fails", async () => {
    completeLink.mockResolvedValue({ ok: true, alreadyLinked: false });
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
