import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ingestGitHubWebhook,
  type GitHubWebhookPayload,
  type IngestGitHubWebhookDeps,
} from "./ingest-github-webhook.js";
import type { InboundItem, InboundItemRepository, Logger } from "@oneon/domain";

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeFakeItem(overrides: Partial<InboundItem> = {}): InboundItem {
  return {
    id: "uuid-gh-001",
    userId: null,
    source: "github",
    externalId: "pr:octocat/hello-world#42",
    from: "octocat",
    subject: "[octocat/hello-world] PR #42: Fix README typo",
    bodyPreview: "Fixed a small typo in the README.",
    receivedAt: "2026-05-05T10:00:00Z",
    rawJson: "{}",
    threadId: "octocat/hello-world#42",
    labels: '["pull_request","opened"]',
    classifiedAt: null,
    classifyAttempts: 0,
    createdAt: "2026-05-05T10:00:00Z",
    updatedAt: "2026-05-05T10:00:00Z",
    ...overrides,
  };
}

function createMockRepo(
  overrides: Partial<InboundItemRepository> = {},
): InboundItemRepository {
  return {
    upsert: vi.fn().mockReturnValue(makeFakeItem()),
    findById: vi.fn().mockReturnValue(null),
    findBySourceAndExternalId: vi.fn().mockReturnValue(null),
    findUnclassified: vi.fn().mockReturnValue([]),
    findAll: vi.fn().mockReturnValue([]),
    search: vi.fn().mockReturnValue([]),
    markClassified: vi.fn(),
    incrementClassifyAttempts: vi.fn(),
    count: vi.fn().mockReturnValue(0),
    ...overrides,
  };
}

const VALID_PAYLOAD: GitHubWebhookPayload = {
  eventType: "pull_request",
  action: "opened",
  externalId: "pr:octocat/hello-world#42",
  number: 42,
  title: "Fix README typo",
  body: "Fixed a small typo in the README.",
  sender: "octocat",
  repo: "octocat/hello-world",
  url: "https://github.com/octocat/hello-world/pull/42",
  createdAt: "2026-05-05T09:55:00Z",
  updatedAt: "2026-05-05T10:00:00Z",
};

describe("ingestGitHubWebhook", () => {
  let logger: Logger;
  let repo: InboundItemRepository;
  let deps: IngestGitHubWebhookDeps;

  beforeEach(() => {
    logger = createMockLogger();
    repo = createMockRepo();
    deps = { inboundItemRepo: repo, logger };
  });

  it("calls upsert with correctly mapped fields", () => {
    ingestGitHubWebhook(deps, VALID_PAYLOAD);

    expect(repo.upsert).toHaveBeenCalledOnce();
    expect(repo.upsert).toHaveBeenCalledWith({
      userId: null,
      source: "github",
      externalId: "pr:octocat/hello-world#42",
      from: "octocat",
      subject: "[octocat/hello-world] PR #42: Fix README typo",
      bodyPreview: "Fixed a small typo in the README.",
      receivedAt: "2026-05-05T10:00:00Z",
      rawJson: JSON.stringify(VALID_PAYLOAD),
      threadId: "octocat/hello-world#42",
      labels: JSON.stringify(["pull_request", "opened"]),
      classifiedAt: null,
      classifyAttempts: 0,
    });
  });

  it("checks existence with source=github and payload external id", () => {
    ingestGitHubWebhook(deps, VALID_PAYLOAD);

    expect(repo.findBySourceAndExternalId).toHaveBeenCalledWith(
      "github",
      "pr:octocat/hello-world#42",
    );
  });

  it("uses resolveUserId in both existence lookup and upsert", () => {
    deps.resolveUserId = () => "user-123";

    ingestGitHubWebhook(deps, VALID_PAYLOAD);

    expect(repo.findBySourceAndExternalId).toHaveBeenCalledWith(
      "github",
      "pr:octocat/hello-world#42",
      "user-123",
    );
    expect(repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-123" }),
    );
  });

  it("returns wasCreated=true when item is new", () => {
    (repo.findBySourceAndExternalId as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const result = ingestGitHubWebhook(deps, VALID_PAYLOAD);

    expect(result.wasCreated).toBe(true);
  });

  it("returns wasCreated=false when item already exists", () => {
    (repo.findBySourceAndExternalId as ReturnType<typeof vi.fn>).mockReturnValue(
      makeFakeItem(),
    );

    const result = ingestGitHubWebhook(deps, VALID_PAYLOAD);

    expect(result.wasCreated).toBe(false);
  });

  it("truncates body preview to 500 characters", () => {
    const payload: GitHubWebhookPayload = {
      ...VALID_PAYLOAD,
      body: "x".repeat(700),
    };

    ingestGitHubWebhook(deps, payload);

    expect(repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ bodyPreview: "x".repeat(500) }),
    );
  });

  it("logs ingestion details", () => {
    ingestGitHubWebhook(deps, VALID_PAYLOAD);

    expect(logger.info).toHaveBeenCalledWith(
      "GitHub webhook: item ingested",
      expect.objectContaining({
        externalId: "pr:octocat/hello-world#42",
        repo: "octocat/hello-world",
        wasCreated: true,
      }),
    );
  });
});
