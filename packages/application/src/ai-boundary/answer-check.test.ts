import { describe, it, expect } from "vitest";
import { z } from "zod";
import { checkAnswer, parseJsonLoose, restoreToolParams } from "./answer-check.js";
import { PlaceholderMap } from "./placeholders.js";

const mapWithAbc = () => {
  const map = new PlaceholderMap();
  map.tokenFor({ type: "customer", id: "c9" }, "ABC Hospital");
  return map;
};

describe("checkAnswer", () => {
  it("O5 restores real names for this turn's tokens", () => {
    expect(checkAnswer({ raw: "Chase CUSTOMER_1 first.", output: "text", map: mapWithAbc() })).toMatchObject({
      ok: true,
      text: "Chase ABC Hospital first.",
      checks: { O1: "pass", O2: "pass", O3: "pass", O4: "skipped" },
    });
  });
  it("O1 blocks an answer containing a real value that was replaced", () => {
    expect(checkAnswer({ raw: "Chase abc hospital first.", output: "text", map: mapWithAbc() })).toMatchObject({ ok: false, reason: "masked_value_leaked" });
  });
  it("O1 ignores a replaced value that the person wrote in this request", () => {
    expect(
      checkAnswer({ raw: "ABC Hospital owes 40.", output: "text", map: mapWithAbc(), userText: "what does ABC Hospital owe?" }),
    ).toMatchObject({ ok: true, checks: { O1: "pass" } });
  });
  it("O1 still blocks the same answer when the person did not write the value", () => {
    expect(checkAnswer({ raw: "ABC Hospital owes 40.", output: "text", map: mapWithAbc(), userText: "who owes?" })).toMatchObject({
      ok: false,
      reason: "masked_value_leaked",
    });
  });
  it("O2 blocks a token not issued this turn", () => {
    expect(checkAnswer({ raw: "Chase CUSTOMER_2.", output: "text", map: mapWithAbc() })).toMatchObject({ ok: false, reason: "unknown_token" });
  });
  it("O3 blocks a secret in the answer", () => {
    expect(checkAnswer({ raw: "Use password: hunter2!", output: "text", map: new PlaceholderMap() })).toMatchObject({ ok: false, reason: "secret_in_output" });
  });
  it("O4 blocks JSON that fails the purpose schema, and accepts fenced JSON that passes", () => {
    const schema = z.object({ answer: z.string() });
    expect(checkAnswer({ raw: "not json", output: "json", schema, map: new PlaceholderMap() })).toMatchObject({ ok: false, reason: "invalid_output" });
    expect(checkAnswer({ raw: '```json\n{"answer":"Chase CUSTOMER_1"}\n```', output: "json", schema, map: mapWithAbc() })).toMatchObject({
      ok: true,
      json: { answer: "Chase ABC Hospital" },
    });
  });
});

describe("checkAnswer without name restoration (intent extraction)", () => {
  it("keeps tokens in place but still runs the checks", () => {
    const map = mapWithAbc();
    expect(checkAnswer({ raw: '[{"tool":"t","parameters":{"customerId":"CUSTOMER_1"}}]', output: "json", map, restoreNames: false })).toMatchObject({
      ok: true,
      json: [{ tool: "t", parameters: { customerId: "CUSTOMER_1" } }],
    });
    expect(checkAnswer({ raw: '[{"tool":"t","parameters":{"x":"CUSTOMER_7"}}]', output: "json", map, restoreNames: false })).toMatchObject({ ok: false, reason: "unknown_token" });
  });
});

describe("restoreToolParams", () => {
  it("restores an exact token to the entity id, and embedded tokens to the display name", () => {
    expect(restoreToolParams({ customerId: "CUSTOMER_1", query: "emails about CUSTOMER_1", limit: 5 }, mapWithAbc())).toEqual({
      ok: true,
      params: { customerId: "c9", query: "emails about ABC Hospital", limit: 5 },
    });
  });
  it("rejects a placeholder not issued this turn (Review Focus 4)", () => {
    expect(restoreToolParams({ customerId: "CUSTOMER_9" }, mapWithAbc())).toEqual({ ok: false, token: "CUSTOMER_9" });
  });
  it("walks nested objects and arrays", () => {
    expect(restoreToolParams({ filter: { ids: ["CUSTOMER_1"] } }, mapWithAbc())).toEqual({ ok: true, params: { filter: { ids: ["c9"] } } });
  });
});

describe("parseJsonLoose", () => {
  it("parses a bare array and a fenced object, and throws on nothing", () => {
    expect(parseJsonLoose('[{"tool":"none","parameters":{}}]')).toEqual([{ tool: "none", parameters: {} }]);
    expect(parseJsonLoose('Here:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(() => parseJsonLoose("no json here")).toThrow(SyntaxError);
  });
});
