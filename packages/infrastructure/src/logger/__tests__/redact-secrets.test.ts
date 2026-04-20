import { describe, it, expect } from "vitest";
import { redactSecrets } from "../structured-logger.js";

// Security: verify log redaction covers all sensitive patterns
describe("redactSecrets", () => {
  it("redacts Authorization Bearer tokens", () => {
    const input = '{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def"}';
    const result = redactSecrets(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
  });

  it("redacts GitHub PATs (ghp_)", () => {
    const input = '{"token":"ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ012345"}';
    const result = redactSecrets(input);
    expect(result).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(result).not.toContain("ghp_aBcDeFgH");
  });

  it("redacts Anthropic keys (sk-ant-)", () => {
    const input = '{"key":"sk-ant-api03-abcdefghijklmnopqrstuvwxyz"}';
    const result = redactSecrets(input);
    expect(result).toContain("[REDACTED_ANTHROPIC_KEY]");
    expect(result).not.toContain("sk-ant-api03");
  });

  it("redacts common secret field names with long values", () => {
    const input = '{"api_token":"someVeryLongSecretValueHere12345"}';
    const result = redactSecrets(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("someVeryLongSecret");
  });

  it("does not redact normal short values", () => {
    const input = '{"message":"User logged in","email":"alice@test.com"}';
    const result = redactSecrets(input);
    expect(result).toBe(input);
  });

  it("does not redact normal log fields", () => {
    const input = '{"level":"info","context":"webhook","message":"GitHub webhook received"}';
    const result = redactSecrets(input);
    expect(result).toBe(input);
  });

  it("handles empty string", () => {
    expect(redactSecrets("")).toBe("");
  });
});
