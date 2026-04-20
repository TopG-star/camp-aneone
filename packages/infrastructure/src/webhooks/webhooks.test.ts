import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  outlookPayloadSchema,
  extractSenderEmail,
} from "./outlook-payload.schema.js";
import { verifyHmacSignature } from "./hmac.js";

// ── Outlook Payload Schema Tests ─────────────────────────────

describe("outlookPayloadSchema", () => {
  const validPayload = {
    id: "AAMkAGI123",
    from: "boss@company.com",
    subject: "Q4 Review",
    bodyPreview: "Please review the Q4 numbers.",
    receivedDateTime: "2025-01-15T10:00:00Z",
    conversationId: "AAQkAGI456",
    categories: ["CATEGORY_PROMOTIONS"],
  };

  it("accepts a valid payload with string from", () => {
    const result = outlookPayloadSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
  });

  it("accepts a valid payload with Graph-style from object", () => {
    const payload = {
      ...validPayload,
      from: {
        emailAddress: {
          name: "Boss",
          address: "boss@company.com",
        },
      },
    };
    const result = outlookPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("defaults subject to (no subject) when missing", () => {
    const { subject, ...rest } = validPayload;
    const result = outlookPayloadSchema.safeParse(rest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subject).toBe("(no subject)");
    }
  });

  it("defaults bodyPreview to empty string when missing", () => {
    const { bodyPreview, ...rest } = validPayload;
    const result = outlookPayloadSchema.safeParse(rest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.bodyPreview).toBe("");
    }
  });

  it("defaults categories to empty array when missing", () => {
    const { categories, ...rest } = validPayload;
    const result = outlookPayloadSchema.safeParse(rest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.categories).toEqual([]);
    }
  });

  it("allows optional conversationId", () => {
    const { conversationId, ...rest } = validPayload;
    const result = outlookPayloadSchema.safeParse(rest);
    expect(result.success).toBe(true);
  });

  it("allows null conversationId", () => {
    const result = outlookPayloadSchema.safeParse({
      ...validPayload,
      conversationId: null,
    });
    expect(result.success).toBe(true);
  });

  it("accepts payload with optional body object", () => {
    const result = outlookPayloadSchema.safeParse({
      ...validPayload,
      body: { content: "<p>Full email body</p>", contentType: "html" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty id", () => {
    const result = outlookPayloadSchema.safeParse({
      ...validPayload,
      id: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing id", () => {
    const { id, ...rest } = validPayload;
    const result = outlookPayloadSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects missing receivedDateTime", () => {
    const { receivedDateTime, ...rest } = validPayload;
    const result = outlookPayloadSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects missing from", () => {
    const { from, ...rest } = validPayload;
    const result = outlookPayloadSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });
});

// ── extractSenderEmail Tests ─────────────────────────────────

describe("extractSenderEmail", () => {
  it("returns string from directly", () => {
    expect(extractSenderEmail("user@example.com")).toBe("user@example.com");
  });

  it("extracts address from Graph-style object", () => {
    expect(
      extractSenderEmail({
        emailAddress: {
          name: "User Name",
          address: "user@example.com",
        },
      })
    ).toBe("user@example.com");
  });
});

// ── HMAC Verification Tests ──────────────────────────────────

describe("verifyHmacSignature", () => {
  const secret = "test-secret-key-123";

  function sign(body: string): string {
    return createHmac("sha256", secret).update(body).digest("hex");
  }

  it("returns true for valid signature", () => {
    const body = '{"id":"test"}';
    const sig = sign(body);
    expect(verifyHmacSignature(body, sig, secret)).toBe(true);
  });

  it("returns false for tampered body", () => {
    const sig = sign('{"id":"test"}');
    expect(verifyHmacSignature('{"id":"tampered"}', sig, secret)).toBe(false);
  });

  it("returns false for wrong secret", () => {
    const body = '{"id":"test"}';
    const sig = sign(body);
    expect(verifyHmacSignature(body, sig, "wrong-secret")).toBe(false);
  });

  it("returns false for empty signature", () => {
    expect(verifyHmacSignature('{"id":"test"}', "", secret)).toBe(false);
  });

  it("returns false for empty secret", () => {
    const body = '{"id":"test"}';
    const sig = sign(body);
    expect(verifyHmacSignature(body, sig, "")).toBe(false);
  });

  it("works with Buffer input", () => {
    const body = Buffer.from('{"id":"test"}');
    const sig = createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyHmacSignature(body, sig, secret)).toBe(true);
  });

  it("rejects signature with different length", () => {
    expect(verifyHmacSignature('{"id":"test"}', "abc", secret)).toBe(false);
  });
});
