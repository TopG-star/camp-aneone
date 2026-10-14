import { describe, expect, it } from "vitest";
import { impressorxTenantIdText, registrationAction, registrationStatusText, suspendConfirmation, resumeConfirmation } from "./platform-ui";

describe("platform console wording", () => {
  it("names the pharmacy's ImpressoRx tenant id, its permanent identity", () => {
    expect(impressorxTenantIdText("9b2c-1f")).toBe("ImpressoRx tenant id: 9b2c-1f");
  });

  it("says plainly whether Oneon serves the pharmacy, and who switched it off", () => {
    expect(registrationStatusText("active")).toBe("Served by Oneon.");
    expect(registrationStatusText("suspended_by_operator")).toBe("Suspended by a platform operator: Oneon is not serving this pharmacy. ImpressoRx is unchanged.");
    expect(registrationStatusText("disabled_by_tenant")).toMatch(/switched Oneon off in ImpressoRx/);
    expect(registrationStatusText("removed")).toMatch(/removed/i);
  });

  it("offers Suspend for an active pharmacy, Resume only for one an operator suspended, and nothing otherwise", () => {
    expect(registrationAction("active")).toBe("suspend");
    expect(registrationAction("suspended_by_operator")).toBe("resume");
    expect(registrationAction("disabled_by_tenant")).toBeNull();
    expect(registrationAction("removed")).toBeNull();
  });

  it("asks before suspending, saying what stops and what does not", () => {
    expect(suspendConfirmation("Acme Pharmacy")).toBe(
      "Suspend Acme Pharmacy? Oneon stops serving it at once: its staff can't open it in Oneon, and nightly jobs skip it. Its file is still backed up. Nothing changes in ImpressoRx, and you can resume it later.",
    );
    expect(resumeConfirmation("Acme Pharmacy")).toBe(
      "Resume Acme Pharmacy? Oneon first brings its file up to date and refreshes its ImpressoRx keys; if either fails it stays suspended and you see why. Then Oneon serves it again.",
    );
  });
});
