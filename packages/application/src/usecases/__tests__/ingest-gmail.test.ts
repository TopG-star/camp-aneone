import { describe, it, expect, vi, beforeEach } from "vitest";
import { ingestGmail } from "../ingest-gmail.js";
import type {
  InboundItem,
  InboundItemRepository,
  IngestionPort,
  Logger,
  Source,
} from "@oneon/domain";

// ── Helpers ──────────────────────────────────────────────────

function makeItem(id: string, externalId: string): InboundItem {
  return {
    id,
    userId: null,
    source: "gmail" as Source,
    externalId,
    from: "alice@example.com",
    subject: `Subject ${id}`,
    bodyPreview: "preview",
    receivedAt: new Date().toISOString(),
    rawJson: "{}",
    threadId: null,
    labels: "[]",
    classifiedAt: null,
    classifyAttempts: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeInboundItemCreate(externalId: string) {
  return {
    source: "gmail" as Source,
    externalId,
    from: "alice@example.com",
    subject: `Subject ${externalId}`,
    bodyPreview: "preview",
    receivedAt: new Date().toISOString(),
    rawJson: "{}",
    threadId: null,
    labels: "[]",
    classifiedAt: null,
    classifyAttempts: 0,
  };
}

function mockIngestionPort(): IngestionPort {
  return {
    fetchNew: vi.fn().mockResolvedValue([]),
  };
}

function mockInboundItemRepo(): InboundItemRepository {
  return {
    upsert: vi.fn((item) => makeItem("uuid-" + item.externalId, item.externalId)),
    findById: vi.fn(),
    findBySourceAndExternalId: vi.fn().mockReturnValue(null),
    findUnclassified: vi.fn(),
    findAll: vi.fn(),
    search: vi.fn(),
    markClassified: vi.fn(),
    incrementClassifyAttempts: vi.fn(),
    count: vi.fn(),
  };
}

function mockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("ingestGmail", () => {
  let ingestionPort: ReturnType<typeof mockIngestionPort>;
  let inboundItemRepo: ReturnType<typeof mockInboundItemRepo>;
  let logger: ReturnType<typeof mockLogger>;

  beforeEach(() => {
    vi.clearAllMocks();
    ingestionPort = mockIngestionPort();
    inboundItemRepo = mockInboundItemRepo();
    logger = mockLogger();
  });

  function run() {
    return ingestGmail({ ingestionPort, inboundItemRepo, logger, userId: "test-user" });
  }

  it("calls ingestionPort.fetchNew() with userId", async () => {
    await run();
    expect(ingestionPort.fetchNew).toHaveBeenCalledWith("test-user");
  });

  it("returns zero counts when no new messages", async () => {
    const result = await run();
    expect(result).toEqual({ ingested: 0, duplicates: 0, errors: 0 });
  });

  it("upserts each fetched item into the repository", async () => {
    const items = [makeInboundItemCreate("ext-1"), makeInboundItemCreate("ext-2")];
    (ingestionPort.fetchNew as ReturnType<typeof vi.fn>).mockResolvedValue(items);

    await run();

    expect(inboundItemRepo.upsert).toHaveBeenCalledTimes(2);
    expect(inboundItemRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ externalId: "ext-1" })
    );
    expect(inboundItemRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ externalId: "ext-2" })
    );
  });

  it("counts newly created items as ingested", async () => {
    const items = [makeInboundItemCreate("ext-1")];
    (ingestionPort.fetchNew as ReturnType<typeof vi.fn>).mockResolvedValue(items);
    // findBySourceAndExternalId returns null → new item
    (inboundItemRepo.findBySourceAndExternalId as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const result = await run();

    expect(result.ingested).toBe(1);
  });

  it("counts existing items as duplicates", async () => {
    const items = [makeInboundItemCreate("ext-1")];
    (ingestionPort.fetchNew as ReturnType<typeof vi.fn>).mockResolvedValue(items);
    // findBySourceAndExternalId returns existing → duplicate
    (inboundItemRepo.findBySourceAndExternalId as ReturnType<typeof vi.fn>).mockReturnValue(
      makeItem("existing-id", "ext-1")
    );

    const result = await run();

    expect(result.duplicates).toBe(1);
    // Still upserts (update case)
    expect(inboundItemRepo.upsert).toHaveBeenCalledTimes(1);
  });

  it("counts and logs individual upsert errors", async () => {
    const items = [makeInboundItemCreate("ext-1"), makeInboundItemCreate("ext-2")];
    (ingestionPort.fetchNew as ReturnType<typeof vi.fn>).mockResolvedValue(items);
    (inboundItemRepo.upsert as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => {
        throw new Error("DB constraint");
      })
      .mockReturnValueOnce(makeItem("uuid-2", "ext-2"));

    const result = await run();

    expect(result.errors).toBe(1);
    expect(result.ingested).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("upsert failed"),
      expect.objectContaining({ externalId: "ext-1" })
    );
  });

  it("propagates fetchNew errors (don't swallow adapter failures)", async () => {
    (ingestionPort.fetchNew as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Gmail API error 401")
    );

    await expect(run()).rejects.toThrow("Gmail API error 401");
  });

  it("logs summary after successful ingestion", async () => {
    const items = [makeInboundItemCreate("ext-1")];
    (ingestionPort.fetchNew as ReturnType<typeof vi.fn>).mockResolvedValue(items);

    await run();

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Gmail ingestion"),
      expect.objectContaining({ ingested: 1 })
    );
  });
});
