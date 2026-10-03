import { describe, it, expect } from "vitest";
import { classRank, higherClass, isDataClass, lowerClass, partKey } from "./types.js";
import { instruction } from "./instruction.js";

describe("data classes", () => {
  it("ranks D0 lowest and D4 highest", () => {
    expect(["D0", "D1", "D2", "D3", "D4"].map((c) => classRank(c as never))).toEqual([0, 1, 2, 3, 4]);
  });
  it("picks the higher and the lower class", () => {
    expect(higherClass("D1", "D3")).toBe("D3");
    expect(lowerClass("D2", "D1")).toBe("D1");
  });
  it("recognises only the five classes", () => {
    expect(isDataClass("D2")).toBe(true);
    expect(isDataClass("d2")).toBe(false);
    expect(isDataClass("D5")).toBe(false);
  });
});

describe("partKey", () => {
  it("names records by source and other parts by kind", () => {
    expect(partKey({ kind: "record", source: "tool:list_inbox", rows: [] })).toBe("record:tool:list_inbox");
    expect(partKey({ kind: "user_message", text: "hi" })).toBe("user_message");
    expect(partKey({ kind: "instruction", text: instruction`x` })).toBe("instruction");
  });
});
