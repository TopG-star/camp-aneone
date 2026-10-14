import { describe, it, expect } from "vitest";
import { NO_PROVIDER_CONFIGURED, changeFailureText, historyEntryText, providerLimitText, tenantClassLabel } from "./tenant-ai-limit-ui";

describe("pharmacy AI limit UI helpers", () => {
  it("names each level a pharmacy may choose in plain words, and passes anything else through", () => {
    expect(tenantClassLabel("D0")).toBe("Public only (nothing about your pharmacy's business; chat replies in this pharmacy are refused at this level)");
    expect(tenantClassLabel("D1")).toBe("Internal (stock and aggregate sales; no customer or supplier names)");
    expect(tenantClassLabel("D2")).toBe("Confidential (names, prices and other identifying detail)");
    expect(tenantClassLabel("D3")).toBe("D3");
  });

  it("says who changed the limit and when", () => {
    expect(historyEntryText({ maxClass: "D0", at: "2026-10-09T12:00:00.000Z", byYou: true })).toBe(
      "Public only (nothing about your pharmacy's business; chat replies in this pharmacy are refused at this level) · 9 Oct 2026 · by you",
    );
    expect(historyEntryText({ maxClass: "D1", at: "2026-10-01T12:00:00.000Z", byYou: false })).toBe(
      "Internal (stock and aggregate sales; no customer or supplier names) · 1 Oct 2026 · by a colleague",
    );
  });

  describe("what each configured provider gets in this pharmacy (spec 9.4, amendment A3)", () => {
    it("a provider at the pharmacy's limit shows the class and its meaning, with no reason", () => {
      expect(providerLimitText({ id: "anthropic", label: "Anthropic", effective: "D2", limitedBy: null })).toBe(
        "Anthropic: D2 · Confidential (names, prices and other identifying detail)",
      );
    });
    it("a provider below it says why", () => {
      expect(providerLimitText({ id: "deepseek", label: "DeepSeek", effective: "D1", limitedBy: "not_cleared" })).toBe(
        "DeepSeek: D1 · held at D1: not reviewed with a DPA (Oneon has not fully reviewed this provider with a signed data processing agreement)",
      );
      expect(providerLimitText({ id: "deepseek", label: "DeepSeek", effective: "D1", limitedBy: "registry" })).toBe(
        "DeepSeek: D1 · held at D1: the most this provider may receive for pharmacy data",
      );
      expect(providerLimitText({ id: "anthropic", label: "Anthropic", effective: "D0", limitedBy: "override" })).toBe(
        "Anthropic: D0 · held at D0: lowered by the platform",
      );
    });
    it("a provider with no class gets nothing at all, and says so", () => {
      expect(providerLimitText({ id: "deepseek", label: "DeepSeek", effective: null, limitedBy: "suspended" })).toBe(
        "DeepSeek: nothing is sent · suspended by the platform",
      );
      expect(providerLimitText({ id: "deepseek", label: "DeepSeek", effective: null, limitedBy: "unknown" })).toBe("DeepSeek: nothing is sent · not available");
    });
    it("with no provider configured, nothing is sent from this pharmacy", () => {
      expect(NO_PROVIDER_CONFIGURED).toBe("No AI provider is configured, so Oneon sends nothing to one from this pharmacy.");
    });
  });

  describe("why a change was not made", () => {
    it("409: a raise stays within a provider's ceiling, and to Confidential it also needs a reviewed provider with a signed agreement", () => {
      expect(changeFailureText(409, "prerequisites_missing")).toBe(
        "The limit can't be raised to this level. A raise has to stay within what a configured AI provider may receive for a pharmacy, and a raise to the Confidential level also needs a provider that Oneon has fully reviewed and that holds a signed data processing agreement.",
      );
      expect(changeFailureText(409, "prerequisites_missing")).not.toMatch(/lower/i);
    });
    it("409 limit_changed: someone else changed it since the page loaded, and nothing was changed", () => {
      expect(changeFailureText(409, "limit_changed")).toBe(
        "Someone else changed the limit after this page loaded, so nothing was changed. The page now shows the current limit; choose again if you still want to change it.",
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
    it("403 context_unavailable: words, never the code", () => {
      expect(changeFailureText(403, "context_unavailable")).toBe(
        "This pharmacy isn't available right now. Open Oneon from ImpressoRx again, or ask a pharmacy administrator. Nothing was changed.",
      );
    });
    it("any other 403 that carries only a code says so in plain words too", () => {
      expect(changeFailureText(403, "tenant_context_required")).toBe("You can't change this right now. Nothing was changed.");
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
