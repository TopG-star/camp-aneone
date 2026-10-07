import { describe, it, expect } from "vitest";
import { instruction } from "./instruction.js";

describe("instruction", () => {
  it("keeps literal text exactly", () => {
    expect(instruction`Return ONLY valid JSON.`).toBe("Return ONLY valid JSON.");
  });

  it("keeps multi-line literals unchanged", () => {
    expect(instruction`line one
line two`).toBe("line one\nline two");
  });

  it("refuses substitutions at compile time and at run time (spec §5.4)", () => {
    const body = "customer data";
    // @ts-expect-error substitutions are typed never, so data cannot be interpolated into an instruction
    expect(() => instruction`Summarise ${body}`).toThrow("instruction takes no substitutions");
  });
});
