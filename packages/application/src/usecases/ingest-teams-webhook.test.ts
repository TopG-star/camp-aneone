import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ingestTeamsWebhook,
  type TeamsWebhookPayload,
  type IngestTeamsWebhookDeps,
} from "./ingest-teams-webhook.js";
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
    id: "uuid-teams-001",
    userId: null,
    source: "teams",
    externalId: "teams-msg-1",
    from: "alice@company.com",
    subject: "Standup notes",
    bodyPreview: "Action items for today",
    receivedAt: "2026-05-05T10:00:00Z",
    rawJson: "{}",
    threadId: null,
    labels: "[]",
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

const VALID_PAYLOAD: TeamsWebhookPayload = {
  id: "teams-msg-1",
  from: "alice@company.com",
  subject: "Standup notes",
  bodyPreview: "Action items for today",
  createdDateTime: "2026-05-05T10:00:00Z",
  channelName: "general",
  teamName: "engineering",
};

describe("ingestTeamsWebhook", () => {
  let logger: Logger;
  let repo: InboundItemRepository;
  let deps: IngestTeamsWebhookDeps;

  beforeEach(() => {
    logger = createMockLogger();
    repo = createMockRepo();
    deps = { inboundItemRepo: repo, logger };
  });

  it("calls upsert with correctly mapped fields", () => {
    ingestTeamsWebhook(deps, VALID_PAYLOAD);

    expect(repo.upsert).toHaveBeenCalledOnce();
    expect(repo.upsert).toHaveBeenCalledWith({
      userId: null,
      source: "teams",
      externalId: "teams-msg-1",
      from: "alice@company.com",
      subject: "Standup notes",
      bodyPreview: "Action items for today",
      receivedAt: "2026-05-05T10:00:00Z",
      rawJson: JSON.stringify(VALID_PAYLOAD),
      threadId: null,
      labels: JSON.stringify(["engineering", "general"]),
      classifiedAt: null,
      classifyAttempts: 0,
    });
  });

  it("checks existence with source=teams and payload id", () => {
    ingestTeamsWebhook(deps, VALID_PAYLOAD);

    expect(repo.findBySourceAndExternalId).toHaveBeenCalledWith(
      "teams",
      "teams-msg-1",
    );
  });

  it("uses resolveUserId in both existence lookup and upsert", () => {
    deps.resolveUserId = () => "user-123";

    ingestTeamsWebhook(deps, VALID_PAYLOAD);

    expect(repo.findBySourceAndExternalId).toHaveBeenCalledWith(
      "teams",
      "teams-msg-1",
      "user-123",
    );
    expect(repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-123" }),
    );
  });

  it("returns wasCreated=true when item is new", () => {
    (repo.findBySourceAndExternalId as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const result = ingestTeamsWebhook(deps, VALID_PAYLOAD);

    expect(result.wasCreated).toBe(true);
  });

  it("returns wasCreated=false when item already exists", () => {
    (repo.findBySourceAndExternalId as ReturnType<typeof vi.fn>).mockReturnValue(
      makeFakeItem(),
    );

    const result = ingestTeamsWebhook(deps, VALID_PAYLOAD);

    expect(result.wasCreated).toBe(false);
  });

  it("serializes labels with only non-null values", () => {
    const payload: TeamsWebhookPayload = {
      ...VALID_PAYLOAD,
      teamName: null,
      channelName: "alerts",
    };

    ingestTeamsWebhook(deps, payload);

    expect(repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ labels: JSON.stringify(["alerts"]) }),
    );
  });

  it("serializes empty labels when team and channel are null", () => {
    const payload: TeamsWebhookPayload = {
      ...VALID_PAYLOAD,
      teamName: null,
      channelName: null,
    };

    ingestTeamsWebhook(deps, payload);

    expect(repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ labels: "[]" }),
    );
  });

  it("returns the upserted item", () => {
    const fakeItem = makeFakeItem({ id: "uuid-returned" });
    (repo.upsert as ReturnType<typeof vi.fn>).mockReturnValue(fakeItem);

    const result = ingestTeamsWebhook(deps, VALID_PAYLOAD);

    expect(result.item.id).toBe("uuid-returned");
  });

  it("logs the ingestion with item details", () => {
    ingestTeamsWebhook(deps, VALID_PAYLOAD);

    expect(logger.info).toHaveBeenCalledWith(
      "Teams webhook: item ingested",
      expect.objectContaining({
        externalId: "teams-msg-1",
        wasCreated: true,
      }),
    );
  });

  it("propagates upsert errors to the caller", () => {
    (repo.upsert as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("DB failure");
    });

    expect(() => ingestTeamsWebhook(deps, VALID_PAYLOAD)).toThrow("DB failure");
  });
});
