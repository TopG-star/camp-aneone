import { describe, expect, it, vi } from "vitest";
import { onSignOut } from "./sign-out";

describe("sign-out", () => {
  it("clears the link intent cookie for a Google session too: a shared browser must not keep a pending link", async () => {
    const deps = { signOutHandoff: vi.fn(), clearLinkCookie: vi.fn() };

    await onSignOut({ token: { provider: "google", sub: "g" } }, deps);

    expect(deps.clearLinkCookie).toHaveBeenCalledOnce();
    expect(deps.signOutHandoff).not.toHaveBeenCalled();
  });

  it("clears it and revokes the attended grant for a hand-off session", async () => {
    const deps = { signOutHandoff: vi.fn(), clearLinkCookie: vi.fn() };

    await onSignOut({ token: { provider: "impressorx", sessionId: "s-1" } }, deps);

    expect(deps.clearLinkCookie).toHaveBeenCalledOnce();
    expect(deps.signOutHandoff).toHaveBeenCalledWith("s-1");
  });

  it("still revokes the grant when the cookie cannot be cleared (no request to answer)", async () => {
    const deps = { signOutHandoff: vi.fn(), clearLinkCookie: vi.fn().mockRejectedValue(new Error("outside a request")) };

    await onSignOut({ token: { provider: "impressorx", sessionId: "s-1" } }, deps);

    expect(deps.signOutHandoff).toHaveBeenCalledWith("s-1");
  });

  it("also clears it when the sign-out carries no token", async () => {
    const deps = { signOutHandoff: vi.fn(), clearLinkCookie: vi.fn() };
    await onSignOut({ session: null } as never, deps);
    expect(deps.clearLinkCookie).toHaveBeenCalledOnce();
  });
});
