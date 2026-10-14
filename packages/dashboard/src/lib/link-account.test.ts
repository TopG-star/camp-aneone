import { describe, expect, it, vi } from "vitest";
import { HANDOFF_NOTICE, LINK_SCOPE_NOTE, LINK_START_FAILED, requestLink } from "./link-account";

describe("requestLink (the Settings button)", () => {
  it("starts the link on the dashboard's own server and returns the next step", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ next: "google" }), { status: 200 }));

    expect(await requestLink(fetchImpl)).toEqual({ next: "google" });
    expect(fetchImpl).toHaveBeenCalledWith("/auth/link/start", { method: "POST", credentials: "include" });
    expect(await requestLink(vi.fn().mockResolvedValue(new Response(JSON.stringify({ next: "handoff" }), { status: 200 })))).toEqual({ next: "handoff" });
  });

  it("explains a failure instead of throwing", async () => {
    for (const fetchImpl of [
      vi.fn().mockResolvedValue(new Response("{}", { status: 401 })),
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ next: "elsewhere" }), { status: 200 })),
      vi.fn().mockResolvedValue(new Response("not json", { status: 200 })),
      vi.fn().mockRejectedValue(new Error("offline")),
    ]) {
      expect(await requestLink(fetchImpl)).toEqual({ error: LINK_START_FAILED });
    }
  });

  it("tells a Google session to open Oneon from ImpressoRx within 5 minutes", () => {
    expect(HANDOFF_NOTICE).toMatch(/ImpressoRx/);
    expect(HANDOFF_NOTICE).toMatch(/5 minutes/);
  });
});

describe("what linking does not do (said on Settings and on the confirmation page)", () => {
  it("says one session still cannot move freely between Personal and a pharmacy, in both directions", () => {
    expect(LINK_SCOPE_NOTE).toBe(
      "Linking doesn't let one session switch freely between Personal and a pharmacy. Signed in with Google, you can use a pharmacy only for a few minutes after you last used it from ImpressoRx. Opened from ImpressoRx, you can't open Personal: sign in with Google for that.",
    );
  });
});
