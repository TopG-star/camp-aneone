import { encode } from "next-auth/jwt";
import { describe, expect, it, vi } from "vitest";
import { linkCsrfToken } from "./link-intent";
import { confirmationQuestion, loadLinkConfirmation } from "./link-confirm";

const ID = "6f1c2c4e-7f0e-4c53-9a43-0f7b6c8f1a11";
const SECRET = "A".repeat(43);
const AUTH_SECRET = "a-test-secret-that-is-at-least-32-characters";
const NAME = "authjs.session-token";
const env = { AUTH_SECRET };

async function cookies(token: Record<string, unknown> | null, intent = true) {
  const parts = ["theme=dark"];
  if (intent) parts.push(`oneon-link-intent=${ID}.${SECRET}`);
  if (token) parts.push(`${NAME}=${await encode({ token, secret: AUTH_SECRET, salt: NAME })}`);
  return parts.join("; ");
}
const google = { sub: "g-sub", email: "gerry@x.com", provider: "google" };
const handoff = { sub: "i-1", provider: "impressorx", identityId: "i-1", sessionId: "s-1", activeContext: { kind: "tenant", membershipId: "m-1" } };
const answer = (status: number, body: unknown) => vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
const opts = (fetchImpl: typeof fetch) => ({ env, fetchImpl, baseUrl: "http://agent:4000", token: "svc" });

describe("loadLinkConfirmation (what GET /auth/link/complete shows; it never links)", () => {
  it("asks 'Link <role> at <pharmacy> to <Google email>?' from the read-only preview, with a token for the Confirm button", async () => {
    const fetchImpl = answer(200, { googleEmail: "gerry@x.com", memberships: [{ role: "Admin", pharmacyName: "Acme Pharmacy" }] });

    const result = await loadLinkConfirmation(await cookies(google), opts(fetchImpl));

    expect(result).toEqual({
      state: "ready",
      question: "Link Admin at Acme Pharmacy to gerry@x.com?",
      csrf: linkCsrfToken({ linkIntentId: ID, secret: SECRET }),
    });
    // Only the preview endpoint was asked: nothing was committed, nothing spent.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0]).toBe("http://agent:4000/api/identity/link/preview");
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body).login).toEqual({ kind: "google", subject: "g-sub", email: "gerry@x.com" });
  });

  it("sends a hand-off's session id and membership for the server to check", async () => {
    const fetchImpl = answer(200, { googleEmail: "gerry@x.com", memberships: [{ role: "Admin", pharmacyName: "Acme" }] });

    await loadLinkConfirmation(await cookies(handoff), opts(fetchImpl));

    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body).login).toEqual({ kind: "impressorx", identityId: "i-1", sessionId: "s-1", membershipId: "m-1" });
  });

  it("has nothing to confirm without a link in progress, and asks for a sign-in without a session", async () => {
    const fetchImpl = vi.fn();
    expect(await loadLinkConfirmation(await cookies(google, false), opts(fetchImpl))).toEqual({ state: "none" });
    expect(await loadLinkConfirmation(await cookies(null), opts(fetchImpl))).toEqual({ state: "signin" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("shows a refusal's reason instead of a question", async () => {
    expect(await loadLinkConfirmation(await cookies(google), opts(answer(409, { error: "link_conflict" })))).toEqual({ state: "refused", reason: "link_conflict" });
    expect(await loadLinkConfirmation(await cookies(google), opts(answer(409, { error: "link_expired" })))).toEqual({ state: "refused", reason: "link_expired" });
  });
});

describe("confirmationQuestion", () => {
  it("names each pharmacy membership, and still asks when there is none to name", () => {
    expect(confirmationQuestion([{ role: "Admin", pharmacyName: "Acme" }, { role: "Pharmacist", pharmacyName: "Bolt" }], "a@b.com")).toBe(
      "Link Admin at Acme and Pharmacist at Bolt to a@b.com?",
    );
    expect(confirmationQuestion([], "a@b.com")).toBe("Link your pharmacy account to a@b.com?");
  });
});
