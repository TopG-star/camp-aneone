import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ingestOutlookWebhook,
  type OutlookWebhookPayload,
  type IngestOutlookWebhookDeps,
} from "./ingest-outlook-webhook.js";
import type { InboundItem, InboundItemRepository, Logger } from "@oneon/domain";

// ── Helpers ──────────────────────────────────────────────────

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
    id: "uuid-001",
    userId: null,
    source: "outlook",
    externalId: "AAMkAGI123",
    from: "boss@company.com",
    subject: "Q4 Review",
    bodyPreview: "Please review the Q4 numbers.",
    receivedAt: "2025-01-15T10:00:00Z",
    rawJson: "{}",
    threadId: "AAQkAGI456",
    labels: "[]",
    classifiedAt: null,
    classifyAttempts: 0,
    createdAt: "2025-01-15T10:00:00Z",
    updatedAt: "2025-01-15T10:00:00Z",
    ...overrides,
  };
}

function createMockRepo(
  overrides: Partial<InboundItemRepository> = {}
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

const VALID_PAYLOAD: OutlookWebhookPayload = {
  id: "AAMkAGI123",
  from: "boss@company.com",
  subject: "Q4 Review",
  bodyPreview: "Please review the Q4 numbers.",
  receivedDateTime: "2025-01-15T10:00:00Z",
  conversationId: "AAQkAGI456",
  categories: ["CATEGORY_PROMOTIONS"],
};

// ── Tests ────────────────────────────────────────────────────

describe("ingestOutlookWebhook", () => {
  let logger: Logger;
  let repo: InboundItemRepository;
  let deps: IngestOutlookWebhookDeps;

  beforeEach(() => {
    logger = createMockLogger();
    repo = createMockRepo();
    deps = { inboundItemRepo: repo, logger };
  });

  it("calls upsert with correctly mapped fields", () => {
    ingestOutlookWebhook(deps, VALID_PAYLOAD);

    expect(repo.upsert).toHaveBeenCalledOnce();
    expect(repo.upsert).toHaveBeenCalledWith({
      userId: null,
      source: "outlook",
      externalId: "AAMkAGI123",
      from: "boss@company.com",
      subject: "Q4 Review",
      bodyPreview: "Please review the Q4 numbers.",
      receivedAt: "2025-01-15T10:00:00Z",
      rawJson: JSON.stringify(VALID_PAYLOAD),
      threadId: "AAQkAGI456",
      labels: JSON.stringify(["CATEGORY_PROMOTIONS"]),
      classifiedAt: null,
      classifyAttempts: 0,
    });
  });

  it("returns the upserted item", () => {
    const fakeItem = makeFakeItem({ id: "uuid-returned" });
    (repo.upsert as ReturnType<typeof vi.fn>).mockReturnValue(fakeItem);

    const result = ingestOutlookWebhook(deps, VALID_PAYLOAD);
    expect(result.item.id).toBe("uuid-returned");
  });

  it("returns wasCreated=true when item is new", () => {
    (repo.findBySourceAndExternalId as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const result = ingestOutlookWebhook(deps, VALID_PAYLOAD);
    expect(result.wasCreated).toBe(true);
  });

  it("returns wasCreated=false when item already exists", () => {
    (repo.findBySourceAndExternalId as ReturnType<typeof vi.fn>).mockReturnValue(
      makeFakeItem()
    );

    const result = ingestOutlookWebhook(deps, VALID_PAYLOAD);
    expect(result.wasCreated).toBe(false);
  });

  it("checks existence with source=outlook and the payload id", () => {
    ingestOutlookWebhook(deps, VALID_PAYLOAD);

    expect(repo.findBySourceAndExternalId).toHaveBeenCalledWith(
      "outlook",
      "AAMkAGI123"
    );
  });

  it("serializes categories as JSON array in labels field", () => {
    const payload: OutlookWebhookPayload = {
      ...VALID_PAYLOAD,
      categories: ["CATEGORY_SOCIAL", "CATEGORY_PROMOTIONS"],
    };

    ingestOutlookWebhook(deps, payload);

    expect(repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        labels: '["CATEGORY_SOCIAL","CATEGORY_PROMOTIONS"]',
      })
    );
  });

  it("maps null conversationId to null threadId", () => {
    const payload: OutlookWebhookPayload = {
      ...VALID_PAYLOAD,
      conversationId: null,
    };

    ingestOutlookWebhook(deps, payload);

    expect(repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: null })
    );
  });

  it("serializes empty categories as empty JSON array", () => {
    const payload: OutlookWebhookPayload = {
      ...VALID_PAYLOAD,
      categories: [],
    };

    ingestOutlookWebhook(deps, payload);

    expect(repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ labels: "[]" })
    );
  });

  it("stores the full payload as rawJson", () => {
    ingestOutlookWebhook(deps, VALID_PAYLOAD);

    const call = (repo.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const rawParsed = JSON.parse(call.rawJson);
    expect(rawParsed.id).toBe("AAMkAGI123");
    expect(rawParsed.from).toBe("boss@company.com");
    expect(rawParsed.categories).toEqual(["CATEGORY_PROMOTIONS"]);
  });

  it("logs the ingestion with item details", () => {
    ingestOutlookWebhook(deps, VALID_PAYLOAD);

    expect(logger.info).toHaveBeenCalledWith(
      "Outlook webhook: item ingested",
      expect.objectContaining({
        externalId: "AAMkAGI123",
        wasCreated: true,
      })
    );
  });

  it("always sets classifiedAt to null (classification is a separate step)", () => {
    ingestOutlookWebhook(deps, VALID_PAYLOAD);

    expect(repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ classifiedAt: null })
    );
  });

  it("is idempotent — calling twice with same payload calls upsert each time", () => {
    // First call: new
    (repo.findBySourceAndExternalId as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);
    const result1 = ingestOutlookWebhook(deps, VALID_PAYLOAD);
    expect(result1.wasCreated).toBe(true);

    // Second call: exists
    (repo.findBySourceAndExternalId as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      makeFakeItem()
    );
    const result2 = ingestOutlookWebhook(deps, VALID_PAYLOAD);
    expect(result2.wasCreated).toBe(false);

    // Upsert was still called both times (idempotent update)
    expect(repo.upsert).toHaveBeenCalledTimes(2);
  });

  it("propagates upsert errors to the caller", () => {
    (repo.upsert as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("DB failure");
    });

    expect(() => ingestOutlookWebhook(deps, VALID_PAYLOAD)).toThrow(
      "DB failure"
    );
  });
});
