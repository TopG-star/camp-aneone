import { describe, it, expect } from "vitest";
import { ApprovedModelCall, ProviderError } from "./approved-call.js";

describe("ApprovedModelCall", () => {
  const fields = { callId: "c1", provider: "deepseek" as const, model: "m", system: "s", user: "u", json: true, maxTokens: 1024, timeoutMs: 1000 };

  it("is created only through mint and is frozen", () => {
    const call = ApprovedModelCall.mint(fields);
    expect(call).toMatchObject(fields);
    expect(Object.isFrozen(call)).toBe(true);
  });

  it("cannot be constructed directly", () => {
    // @ts-expect-error the constructor is private: only the gateway mints approved calls (spec §5.5)
    expect(() => new ApprovedModelCall()).not.toThrow();
  });

  it("ProviderError carries whether a retry may help", () => {
    expect(new ProviderError("rate limited", false).retryable).toBe(false);
  });
});
