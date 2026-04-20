import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ingestGitHubWebhook,
  type GitHubWebhookPayload,
  type IngestGitHubWebhookDeps,
} from "../ingest-github-webhook.js";
import type { InboundItem, InboundItemRepository, Logger } from "@oneon/domain";

// ── Helpers ──────────────────────────────────────────────────

function makeDeps(overrides: Partial<IngestGitHubWebhookDeps> = {}): IngestGitHubWebhookDeps {
  const item: InboundItem = {
    id: "item-1",
    userId: null,
    source: "github",
    externalId: "pr:owner/repo#1",
    from: "alice",
    subject: "[owner/repo] PR #1: Add feature",
    bodyPreview: "Description here",
    receivedAt: "2026-04-18T10:00:00Z",
    rawJson: "{}",
    threadId: "owner/repo#1",
    labels: '["pull_request","opened"]',
    classifiedAt: null,
    classifyAttempts: 0,
    createdAt: "2026-04-18T10:00:00Z",
    updatedAt: "2026-04-18T10:00:00Z",
  };

  return {
    inboundItemRepo: {
      upsert: vi.fn().mockReturnValue(item),
      findById: vi.fn(),
      findBySourceAndExternalId: vi.fn().mockReturnValue(null),
      findUnclassified: vi.fn().mockReturnValue([]),
      search: vi.fn().mockReturnValue([]),
    } as unknown as InboundItemRepository,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger,
    ...overrides,
  };
}

function makePRPayload(overrides: Partial<GitHubWebhookPayload> = {}): GitHubWebhookPayload {
  return {
    eventType: "pull_request",
    action: "opened",
    externalId: "pr:owner/repo#1",
    number: 1,
    title: "Add feature",
    body: "Description here",
    sender: "alice",
    repo: "owner/repo",
    url: "https://github.com/owner/repo/pull/1",
    createdAt: "2026-04-18T09:00:00Z",
    updatedAt: "2026-04-18T10:00:00Z",
    ...overrides,
  };
}

function makeIssuePayload(overrides: Partial<GitHubWebhookPayload> = {}): GitHubWebhookPayload {
  return {
    eventType: "issues",
    action: "opened",
    externalId: "issue:owner/repo#10",
    number: 10,
    title: "Bug report",
    body: "Something is broken",
    sender: "bob",
    repo: "owner/repo",
    url: "https://github.com/owner/repo/issues/10",
    createdAt: "2026-04-18T09:00:00Z",
    updatedAt: "2026-04-18T10:00:00Z",
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────

describe("ingestGitHubWebhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("upserts a PR payload as InboundItem with source 'github'", () => {
    const deps = makeDeps();

    ingestGitHubWebhook(deps, makePRPayload());

    expect(deps.inboundItemRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "github",
        externalId: "pr:owner/repo#1",
        from: "alice",
        subject: "[owner/repo] PR #1: Add feature",
        threadId: "owner/repo#1",
      }),
    );
  });

  it("upserts an issue payload as InboundItem", () => {
    const deps = makeDeps();

    ingestGitHubWebhook(deps, makeIssuePayload());

    expect(deps.inboundItemRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "github",
        externalId: "issue:owner/repo#10",
        from: "bob",
        subject: "[owner/repo] Issue #10: Bug report",
        threadId: "owner/repo#10",
      }),
    );
  });

  it("includes event type and action in labels", () => {
    const deps = makeDeps();

    ingestGitHubWebhook(deps, makePRPayload({ action: "synchronize" }));

    expect(deps.inboundItemRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        labels: '["pull_request","synchronize"]',
      }),
    );
  });

  it("truncates body to 500 chars for bodyPreview", () => {
    const deps = makeDeps();
    const longBody = "x".repeat(1000);

    ingestGitHubWebhook(deps, makePRPayload({ body: longBody }));

    const upsertArg = (deps.inboundItemRepo.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(upsertArg.bodyPreview).toHaveLength(500);
  });

  it("defaults null body to empty string for bodyPreview", () => {
    const deps = makeDeps();

    ingestGitHubWebhook(deps, makePRPayload({ body: null }));

    const upsertArg = (deps.inboundItemRepo.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(upsertArg.bodyPreview).toBe("");
  });

  it("returns wasCreated: true when item is new", () => {
    const deps = makeDeps();
    (deps.inboundItemRepo.findBySourceAndExternalId as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const result = ingestGitHubWebhook(deps, makePRPayload());

    expect(result.wasCreated).toBe(true);
  });

  it("returns wasCreated: false when item already exists", () => {
    const deps = makeDeps();
    (deps.inboundItemRepo.findBySourceAndExternalId as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "existing-item",
    });

    const result = ingestGitHubWebhook(deps, makePRPayload());

    expect(result.wasCreated).toBe(false);
  });

  it("logs ingestion details", () => {
    const deps = makeDeps();

    ingestGitHubWebhook(deps, makePRPayload());

    expect(deps.logger.info).toHaveBeenCalledWith(
      "GitHub webhook: item ingested",
      expect.objectContaining({
        eventType: "pull_request",
        action: "opened",
        repo: "owner/repo",
        number: 1,
      }),
    );
  });

  it("sets classifiedAt to null and classifyAttempts to 0", () => {
    const deps = makeDeps();

    ingestGitHubWebhook(deps, makePRPayload());

    expect(deps.inboundItemRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        classifiedAt: null,
        classifyAttempts: 0,
      }),
    );
  });

  it("uses updatedAt as receivedAt", () => {
    const deps = makeDeps();

    ingestGitHubWebhook(deps, makePRPayload({ updatedAt: "2026-04-18T12:00:00Z" }));

    expect(deps.inboundItemRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        receivedAt: "2026-04-18T12:00:00Z",
      }),
    );
  });
});
