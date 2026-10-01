import { describe, it, expect } from "vitest";
import { createActionRegistry, ActionTypeNotFoundError } from "./registry.js";
import { GMAIL_DEFINITIONS } from "./definitions/gmail.js";

describe("action registry", () => {
  it("returns registered definitions and refuses anything else", () => {
    const registry = createActionRegistry(GMAIL_DEFINITIONS);
    expect(registry.get("archive").type).toBe("archive");
    expect(registry.has("create_purchase_order")).toBe(false);
    expect(() => registry.get("create_purchase_order")).toThrow(ActionTypeNotFoundError);
  });

  it("refuses duplicate registration", () => {
    expect(() => createActionRegistry([...GMAIL_DEFINITIONS, GMAIL_DEFINITIONS[0]])).toThrow('Action type "archive" is already registered');
  });
});
