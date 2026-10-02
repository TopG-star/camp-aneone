import { describe, it, expect } from "vitest";
import { LIFECYCLE_STATUS_VALUES, STATUS_GROUPS, groupOf } from "./actions.contract.js";

describe("STATUS_GROUPS", () => {
  it("places every lifecycle status in exactly one group", () => {
    const flattened = Object.values(STATUS_GROUPS).flat() as string[];
    expect(new Set(flattened).size).toBe(flattened.length);
    expect([...flattened].sort()).toEqual([...LIFECYCLE_STATUS_VALUES].sort());
  });

  it("groupOf agrees with the table for every status", () => {
    for (const status of LIFECYCLE_STATUS_VALUES) {
      expect((STATUS_GROUPS[groupOf(status)] as readonly string[]).includes(status)).toBe(true);
    }
  });
});
