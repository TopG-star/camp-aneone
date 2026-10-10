import { describe, it, expect } from "vitest";
import { changeFailureText, historyEntryText, tenantClassLabel } from "./tenant-ai-limit-ui";

describe("pharmacy AI limit UI helpers", () => {
  it("names each level a pharmacy may choose in plain words, and passes anything else through", () => {
    expect(tenantClassLabel("D0")).toBe("Public only (nothing about your pharmacy's business)");
    expect(tenantClassLabel("D1")).toBe("Internal (stock and sales figures; no customer or supplier names)");
    expect(tenantClassLabel("D2")).toBe("Confidential (names, prices and other identifying detail)");
    expect(tenantClassLabel("D3")).toBe("D3");
  });

  it("says who changed the limit and when", () => {
    expect(historyEntryText({ maxClass: "D0", at: "2026-10-09T12:00:00.000Z", byYou: true })).toBe(
      "Public only (nothing about your pharmacy's business) · 9 Oct 2026 · by you",
    );
    expect(historyEntryText({ maxClass: "D1", at: "2026-10-01T12:00:00.000Z", byYou: false })).toBe(
      "Internal (stock and sales figures; no customer or supplier names) · 1 Oct 2026 · by a colleague",
    );
  });

  describe("why a change was not made", () => {
    it("409: raising needs a reviewed provider with a signed agreement, and lowering is still open", () => {
      expect(changeFailureText(409, "prerequisites_missing")).toBe(
        "The limit can't be raised yet. Raising it needs an AI provider that Oneon has fully reviewed, that holds a signed data processing agreement and that is cleared for this level. You can always lower it.",
      );
    });
    it("403 without permission: only an administrator, and nothing was changed", () => {
      expect(changeFailureText(403, "permission_required")).toBe("Only a pharmacy administrator can change this. Your access in ImpressoRx doesn't include managing Oneon. Nothing was changed.");
    });
    it("403 from a pharmacy that cannot open: the server's own words", () => {
      expect(changeFailureText(403, "Your pharmacy details are out of date. Open Oneon from ImpressoRx again to continue.")).toBe(
        "Your pharmacy details are out of date. Open Oneon from ImpressoRx again to continue.",
      );
    });
    it("503: ImpressoRx could not be asked, and nothing was changed", () => {
      expect(changeFailureText(503, "impressorx_unreachable")).toBe(
        "Oneon can't reach ImpressoRx right now, so it can't check your access. Nothing was changed. Try again in a moment.",
      );
    });
    it("anything else is a plain failure that changed nothing", () => {
      expect(changeFailureText(500, "Internal server error")).toBe("Couldn't change the limit. Nothing was changed. Try again.");
      expect(changeFailureText(0, "")).toBe("Couldn't change the limit. Nothing was changed. Try again.");
    });
  });
});
