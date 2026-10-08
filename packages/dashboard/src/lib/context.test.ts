import { describe, expect, it } from "vitest";
import { contextChoice, contextLabel, contextValue, isContextRefusal, parseContextChoice, pickerOptions, pickerVisible, type ContextOption } from "./context";

const personal: ContextOption = { kind: "personal" };
const acme: ContextOption = { kind: "tenant", membershipId: "m1", tenantName: "Acme Pharmacy", role: "Admin" };
const beta: ContextOption = { kind: "tenant", membershipId: "m2", tenantName: "Beta Pharmacy", role: "WarehouseStaff" };

describe("context picker labels", () => {
  it("shows Personal, and each pharmacy by name with the role", () => {
    expect(contextLabel(personal)).toBe("Personal");
    expect(contextLabel(acme)).toBe("Acme Pharmacy · Admin");
  });

  it("gives each option its own select value and the choice the server expects", () => {
    expect(contextValue(personal)).toBe("personal");
    expect(contextValue(acme)).toBe("tenant:m1");
    expect(contextChoice(personal)).toEqual({ kind: "personal" });
    expect(contextChoice(acme)).toEqual({ kind: "tenant", membershipId: "m1" });
  });

  it("offers the available contexts, plus the current one when it is not among them (a suspended pharmacy)", () => {
    expect(pickerOptions({ active: acme, available: [personal, acme, beta] })).toEqual([personal, acme, beta]);
    expect(pickerOptions({ active: acme, available: [personal] })).toEqual([acme, personal]);
  });
});

describe("pickerVisible", () => {
  it("hides the picker from a person who has only the personal context, and shows it once a pharmacy is involved", () => {
    expect(pickerVisible({ active: personal, available: [personal] })).toBe(false);
    expect(pickerVisible({ active: personal, available: [personal, acme] })).toBe(true);
    expect(pickerVisible({ active: acme, available: [acme] })).toBe(true); // a hand-off session shows where it is working
    expect(pickerVisible({ active: acme, available: [] })).toBe(true); // a suspended pharmacy is still shown as current
  });
});

describe("parseContextChoice", () => {
  it("accepts exactly the two shapes the server validates and drops everything else", () => {
    expect(parseContextChoice({ kind: "personal" })).toEqual({ kind: "personal" });
    expect(parseContextChoice({ kind: "tenant", membershipId: "m1" })).toEqual({ kind: "tenant", membershipId: "m1" });
    expect(parseContextChoice({ kind: "personal", membershipId: "m1", tenantId: "t" })).toEqual({ kind: "personal" });
    expect(parseContextChoice({ kind: "tenant", membershipId: "m1", tenantId: "t" })).toEqual({ kind: "tenant", membershipId: "m1" });
  });

  it.each([undefined, null, "personal", 7, {}, { kind: "tenant" }, { kind: "tenant", membershipId: "" }, { kind: "tenant", membershipId: 3 }, { kind: "other" }])(
    "rejects %j",
    (value) => {
      expect(parseContextChoice(value)).toBeNull();
    },
  );
});

describe("context refusals", () => {
  it("recognises the two codes the person is told about", () => {
    expect(isContextRefusal("launch_required")).toBe(true);
    expect(isContextRefusal("membership_suspended")).toBe(true);
    expect(isContextRefusal("context_unavailable")).toBe(false);
    expect(isContextRefusal(undefined)).toBe(false);
  });
});
