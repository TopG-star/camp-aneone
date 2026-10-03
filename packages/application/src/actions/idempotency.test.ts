import { describe, it, expect } from "vitest";
import { canonicalJson, chatKey, retryKey, emailKey, deadlineKey } from "./idempotency.js";

describe("idempotency keys", () => {
  it("canonicalises key order and nesting", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
  });

  it("gives identical inputs the same chat key regardless of key order", () => {
    expect(chatKey("msg-1", { title: "x", start: "s" })).toBe(chatKey("msg-1", { start: "s", title: "x" }));
    expect(chatKey("msg-1", { title: "x" })).toMatch(/^chat:msg-1:[0-9a-f]{64}$/);
    expect(chatKey("msg-2", { title: "x" })).not.toBe(chatKey("msg-1", { title: "x" }));
  });

  it("derives retry keys from the root key", () => {
    expect(retryKey("email:i1", 1)).toBe("email:i1:retry:1");
    expect(retryKey("email:i1:retry:1", 2)).toBe("email:i1:retry:2");
  });

  it("builds source keys", () => {
    expect(emailKey("i1")).toBe("email:i1");
    expect(deadlineKey("d1")).toBe("deadline:d1");
  });
});
