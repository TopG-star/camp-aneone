import { describe, it, expect } from "vitest";
import { githubPRPayloadSchema, githubIssuePayloadSchema } from "../github-payload.schema.js";

// ── Fixtures ─────────────────────────────────────────────────

function validPRPayload() {
  return {
    action: "opened",
    number: 1,
    pull_request: {
      id: 123,
      number: 1,
      title: "Add feature",
      state: "open",
      user: { login: "alice" } as { login: string } | null,
      html_url: "https://github.com/owner/repo/pull/1",
      body: "Description here",
      created_at: "2026-04-18T09:00:00Z",
      updated_at: "2026-04-18T10:00:00Z",
    },
    repository: { full_name: "owner/repo" },
    sender: { login: "alice" },
  };
}

function validIssuePayload() {
  return {
    action: "opened",
    issue: {
      id: 456,
      number: 10,
      title: "Bug report",
      state: "open",
      user: { login: "bob" } as { login: string } | null,
      html_url: "https://github.com/owner/repo/issues/10",
      body: "Something is broken",
      created_at: "2026-04-18T09:00:00Z",
      updated_at: "2026-04-18T10:00:00Z",
    },
    repository: { full_name: "owner/repo" },
    sender: { login: "bob" },
  };
}

// ── PR Payload Schema ────────────────────────────────────────

describe("githubPRPayloadSchema", () => {
  it("parses a valid PR webhook payload", () => {
    const result = githubPRPayloadSchema.parse(validPRPayload());
    expect(result.action).toBe("opened");
    expect(result.pull_request.title).toBe("Add feature");
    expect(result.repository.full_name).toBe("owner/repo");
    expect(result.sender.login).toBe("alice");
  });

  it("accepts synchronize action", () => {
    const payload = { ...validPRPayload(), action: "synchronize" };
    const result = githubPRPayloadSchema.parse(payload);
    expect(result.action).toBe("synchronize");
  });

  it("accepts ready_for_review action", () => {
    const payload = { ...validPRPayload(), action: "ready_for_review" };
    const result = githubPRPayloadSchema.parse(payload);
    expect(result.action).toBe("ready_for_review");
  });

  it("defaults null user", () => {
    const payload = validPRPayload();
    payload.pull_request.user = null;
    const result = githubPRPayloadSchema.parse(payload);
    expect(result.pull_request.user).toBeNull();
  });

  it("defaults missing title to (no title)", () => {
    const payload = validPRPayload();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (payload.pull_request as any).title;
    const result = githubPRPayloadSchema.parse(payload);
    expect(result.pull_request.title).toBe("(no title)");
  });

  it("rejects missing action", () => {
    const { action, ...rest } = validPRPayload();
    expect(() => githubPRPayloadSchema.parse(rest)).toThrow();
  });

  it("rejects missing pull_request", () => {
    const { pull_request, ...rest } = validPRPayload();
    expect(() => githubPRPayloadSchema.parse(rest)).toThrow();
  });

  it("rejects missing repository", () => {
    const { repository, ...rest } = validPRPayload();
    expect(() => githubPRPayloadSchema.parse(rest)).toThrow();
  });

  it("rejects invalid html_url", () => {
    const payload = validPRPayload();
    payload.pull_request.html_url = "not-a-url";
    expect(() => githubPRPayloadSchema.parse(payload)).toThrow();
  });
});

// ── Issue Payload Schema ─────────────────────────────────────

describe("githubIssuePayloadSchema", () => {
  it("parses a valid issue webhook payload", () => {
    const result = githubIssuePayloadSchema.parse(validIssuePayload());
    expect(result.action).toBe("opened");
    expect(result.issue.title).toBe("Bug report");
    expect(result.repository.full_name).toBe("owner/repo");
    expect(result.sender.login).toBe("bob");
  });

  it("defaults null user", () => {
    const payload = validIssuePayload();
    payload.issue.user = null;
    const result = githubIssuePayloadSchema.parse(payload);
    expect(result.issue.user).toBeNull();
  });

  it("defaults missing body to null", () => {
    const payload = validIssuePayload();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (payload.issue as any).body;
    const result = githubIssuePayloadSchema.parse(payload);
    expect(result.issue.body).toBeNull();
  });

  it("rejects missing issue", () => {
    const { issue, ...rest } = validIssuePayload();
    expect(() => githubIssuePayloadSchema.parse(rest)).toThrow();
  });

  it("rejects missing sender", () => {
    const { sender, ...rest } = validIssuePayload();
    expect(() => githubIssuePayloadSchema.parse(rest)).toThrow();
  });
});
