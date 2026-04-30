import { describe, it, expect, vi, beforeEach } from "vitest";
import { ingestGmail } from "../ingest-gmail.js";
import type {
  InboundItem,
  InboundItemRepository,
  IngestionPort,
  Logger,
  Source,
} from "@oneon/domain";

type BankStatementStatus =
  | "discovered"
  | "metadata_parsed"
  | "error_metadata"
  | "transactions_parsed"
  | "error_transactions";

interface BankStatementRecord {
  id: string;
  userId: string | null;
  source: Source;
  externalId: string;
  messageId: string;
  threadId: string | null;
  sender: string;
  senderDomain: string;
  subject: string;
  receivedAt: string;
  status: BankStatementStatus;
  detectionRuleVersion: string;
  createdAt: string;
  updatedAt: string;
}

interface BankStatementIntakeConfig {
  repository: {
    upsert: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    findBySourceAndExternalId: ReturnType<typeof vi.fn>;
    findByStatus: ReturnType<typeof vi.fn>;
    markMetadataParsed: ReturnType<typeof vi.fn>;
    markErrorMetadata: ReturnType<typeof vi.fn>;
    markTransactionsParsed: ReturnType<typeof vi.fn>;
    markTransactionsError: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
  senderAllowlist: string[];
  subjectKeywords: string[];
  detectionRuleVersion: string;
}

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

function makeBankStatement(
  id: string,
  externalId: string,
  status: BankStatementStatus
): BankStatementRecord {
  const now = new Date().toISOString();
  return {
    id,
    userId: "test-user",
    source: "gmail" as Source,
    externalId,
    messageId: externalId,
    threadId: "thread-1",
    sender: "alerts@chase.com",
    senderDomain: "chase.com",
    subject: "Your statement is ready",
    receivedAt: now,
    status,
    detectionRuleVersion: "fin-001a-v1",
    createdAt: now,
    updatedAt: now,
  };
}

function mockBankStatementRepo() {
  return {
    upsert: vi.fn((input: { externalId: string; status: BankStatementStatus }) =>
      makeBankStatement("bank-" + input.externalId, input.externalId, input.status)
    ),
    findById: vi.fn().mockReturnValue(null),
    findBySourceAndExternalId: vi.fn().mockReturnValue(null),
    findByStatus: vi.fn().mockReturnValue([]),
    markMetadataParsed: vi.fn(),
    markErrorMetadata: vi.fn(),
    markTransactionsParsed: vi.fn(),
    markTransactionsError: vi.fn(),
    count: vi.fn().mockReturnValue(0),
  };
}

function makeCandidateItem(externalId: string) {
  return {
    source: "gmail" as Source,
    externalId,
    from: "alerts@chase.com",
    subject: "Your monthly statement is ready",
    bodyPreview: "New statement available.",
    receivedAt: new Date().toISOString(),
    rawJson: JSON.stringify({
      id: externalId,
      threadId: "thread-1",
    }),
    threadId: "thread-1",
    labels: "[]",
    classifiedAt: null,
    classifyAttempts: 0,
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

  function run(bankStatementIntake?: BankStatementIntakeConfig) {
    return ingestGmail({
      ingestionPort,
      inboundItemRepo,
      logger,
      userId: "test-user",
      bankStatementIntake,
    });
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

  it("stores finance candidate and transitions to metadata_parsed", async () => {
    const items = [makeCandidateItem("fin-ext-1")];
    (ingestionPort.fetchNew as ReturnType<typeof vi.fn>).mockResolvedValue(items);

    const bankRepo = mockBankStatementRepo();

    await run({
      repository: bankRepo,
      senderAllowlist: ["chase.com"],
      subjectKeywords: ["statement", "monthly"],
      detectionRuleVersion: "fin-001a-v1",
    });

    expect(bankRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "test-user",
        source: "gmail",
        externalId: "fin-ext-1",
        messageId: "fin-ext-1",
        threadId: "thread-1",
        sender: "alerts@chase.com",
        senderDomain: "chase.com",
        subject: "Your monthly statement is ready",
        status: "discovered",
        detectionRuleVersion: "fin-001a-v1",
      })
    );

    expect(bankRepo.markMetadataParsed).toHaveBeenCalledWith("bank-fin-ext-1");
    expect(bankRepo.markErrorMetadata).not.toHaveBeenCalled();
  });

  it("marks duplicate finance candidate as error_metadata", async () => {
    const items = [makeCandidateItem("fin-ext-dup")];
    (ingestionPort.fetchNew as ReturnType<typeof vi.fn>).mockResolvedValue(items);

    const bankRepo = mockBankStatementRepo();
    bankRepo.findBySourceAndExternalId.mockReturnValue(
      makeBankStatement("bank-existing", "fin-ext-dup", "discovered")
    );

    await run({
      repository: bankRepo,
      senderAllowlist: ["chase.com"],
      subjectKeywords: ["statement", "monthly"],
      detectionRuleVersion: "fin-001a-v1",
    });

    expect(bankRepo.findBySourceAndExternalId).toHaveBeenCalledWith(
      "gmail",
      "fin-ext-dup",
      "test-user"
    );
    expect(bankRepo.markErrorMetadata).toHaveBeenCalledWith("bank-existing");
    expect(bankRepo.markMetadataParsed).not.toHaveBeenCalled();
  });

  it("does not store non-candidate messages in finance intake", async () => {
    const items = [
      {
        ...makeInboundItemCreate("ext-non-fin"),
        from: "noreply@github.com",
        subject: "Build succeeded",
      },
    ];
    (ingestionPort.fetchNew as ReturnType<typeof vi.fn>).mockResolvedValue(items);

    const bankRepo = mockBankStatementRepo();

    await run({
      repository: bankRepo,
      senderAllowlist: ["chase.com", "bankofamerica.com"],
      subjectKeywords: ["statement"],
      detectionRuleVersion: "fin-001a-v1",
    });

    expect(bankRepo.upsert).not.toHaveBeenCalled();
    expect(bankRepo.markMetadataParsed).not.toHaveBeenCalled();
    expect(bankRepo.markErrorMetadata).not.toHaveBeenCalled();
    expect(bankRepo.markTransactionsParsed).not.toHaveBeenCalled();
    expect(bankRepo.markTransactionsError).not.toHaveBeenCalled();
  });
});
