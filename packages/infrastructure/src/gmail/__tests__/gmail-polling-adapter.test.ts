import { describe, it, expect, vi, beforeEach } from "vitest";
import { GmailPollingAdapter } from "../gmail-polling-adapter.js";
import type { GmailHttpClient, ListMessageIdsOptions } from "../gmail-http-client.js";
import type { GmailMessageResource, GmailSkipConfig } from "../gmail.types.js";
import type { PreferenceRepository, Logger } from "@oneon/domain";

// ── Helpers ──────────────────────────────────────────────────

function makeMessage(
  id: string,
  overrides: Partial<GmailMessageResource> = {}
): GmailMessageResource {
  return {
    id,
    threadId: `thread-${id}`,
    labelIds: ["INBOX"],
    snippet: `Snippet for ${id}`,
    internalDate: String(Date.now()),
    payload: {
      headers: [
        { name: "From", value: "alice@example.com" },
        { name: "Subject", value: `Subject ${id}` },
        { name: "Date", value: "2025-01-15T10:00:00Z" },
      ],
    },
    ...overrides,
  };
}

function mockClient(): GmailHttpClient {
  return {
    listMessageIds: vi.fn().mockResolvedValue({ messages: [], resultSizeEstimate: 0 }),
    getMessage: vi.fn(),
  } as unknown as GmailHttpClient;
}

function mockPreferenceRepo(): PreferenceRepository {
  const store = new Map<string, string>();
  return {
    get: vi.fn((key: string) => store.get(key) ?? null),
    set: vi.fn((key: string, value: string) => {
      store.set(key, value);
      return { key, value, updatedAt: new Date().toISOString() };
    }),
    getAll: vi.fn(() => []),
    delete: vi.fn(),
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

const DEFAULT_SKIP: GmailSkipConfig = {
  skipPromotions: true,
  skipSocial: true,
};

const TEST_USER_ID = "test-user-1";

describe("GmailPollingAdapter", () => {
  let client: ReturnType<typeof mockClient>;
  let prefRepo: ReturnType<typeof mockPreferenceRepo>;
  let logger: ReturnType<typeof mockLogger>;

  beforeEach(() => {
    vi.clearAllMocks();
    client = mockClient();
    prefRepo = mockPreferenceRepo();
    logger = mockLogger();
  });

  function createAdapter(
    skipConfig: GmailSkipConfig = DEFAULT_SKIP,
    maxResults = 20
  ) {
    return new GmailPollingAdapter({
      client,
      preferenceRepo: prefRepo,
      logger,
      skipConfig,
      maxResults,
    });
  }

  // ── Basic fetchNew behavior ─────────────────────────────

  it("returns empty array when Gmail has no messages", async () => {
    const adapter = createAdapter();
    const items = await adapter.fetchNew(TEST_USER_ID);
    expect(items).toEqual([]);
  });

  it("fetches message details for each listed ID", async () => {
    const msg = makeMessage("msg-1");
    (client.listMessageIds as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [{ id: "msg-1", threadId: "t-1" }],
      resultSizeEstimate: 1,
    });
    (client.getMessage as ReturnType<typeof vi.fn>).mockResolvedValue(msg);

    const adapter = createAdapter();
    const items = await adapter.fetchNew(TEST_USER_ID);

    expect(client.getMessage).toHaveBeenCalledWith("msg-1");
    expect(items).toHaveLength(1);
  });

  it("maps Gmail message to InboundItem shape", async () => {
    const msg = makeMessage("msg-1", {
      threadId: "thread-abc",
      snippet: "Hello world snippet",
      internalDate: "1705312800000", // 2024-01-15T10:00:00Z
      payload: {
        headers: [
          { name: "From", value: "bob@test.com" },
          { name: "Subject", value: "Test Subject" },
          { name: "Date", value: "Mon, 15 Jan 2024 10:00:00 +0000" },
        ],
      },
      labelIds: ["INBOX", "IMPORTANT"],
    });
    (client.listMessageIds as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [{ id: "msg-1", threadId: "thread-abc" }],
      resultSizeEstimate: 1,
    });
    (client.getMessage as ReturnType<typeof vi.fn>).mockResolvedValue(msg);

    const adapter = createAdapter();
    const [item] = await adapter.fetchNew(TEST_USER_ID);

    expect(item.source).toBe("gmail");
    expect(item.externalId).toBe("msg-1");
    expect(item.from).toBe("bob@test.com");
    expect(item.subject).toBe("Test Subject");
    expect(item.bodyPreview).toBe("Hello world snippet");
    expect(item.threadId).toBe("thread-abc");
    expect(item.labels).toBe(JSON.stringify(["INBOX", "IMPORTANT"]));
    expect(item.classifyAttempts).toBe(0);
    expect(item.userId).toBe(TEST_USER_ID);
    // receivedAt should be ISO from internalDate epoch ms
    expect(item.receivedAt).toBe("2024-01-15T10:00:00.000Z");
  });

  it("uses snippet as bodyPreview", async () => {
    const msg = makeMessage("msg-1", { snippet: "Preview text here" });
    (client.listMessageIds as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [{ id: "msg-1", threadId: "t-1" }],
      resultSizeEstimate: 1,
    });
    (client.getMessage as ReturnType<typeof vi.fn>).mockResolvedValue(msg);

    const adapter = createAdapter();
    const [item] = await adapter.fetchNew(TEST_USER_ID);

    expect(item.bodyPreview).toBe("Preview text here");
  });

  // ── In-memory seen-ID deduplication (FR-010) ────────────

  it("skips already-seen message IDs in the same session", async () => {
    const msg = makeMessage("msg-1");
    (client.listMessageIds as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [{ id: "msg-1", threadId: "t-1" }],
      resultSizeEstimate: 1,
    });
    (client.getMessage as ReturnType<typeof vi.fn>).mockResolvedValue(msg);

    const adapter = createAdapter();
    const first = await adapter.fetchNew(TEST_USER_ID);
    const second = await adapter.fetchNew(TEST_USER_ID);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    // getMessage only called once — second call skipped the seen ID
    expect(client.getMessage).toHaveBeenCalledTimes(1);
  });

  // ── Label filtering (FR-009) ───────────────────────────

  it("skips CATEGORY_PROMOTIONS when skipPromotions=true", async () => {
    const msg = makeMessage("msg-1", {
      labelIds: ["INBOX", "CATEGORY_PROMOTIONS"],
    });
    (client.listMessageIds as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [{ id: "msg-1", threadId: "t-1" }],
      resultSizeEstimate: 1,
    });
    (client.getMessage as ReturnType<typeof vi.fn>).mockResolvedValue(msg);

    const adapter = createAdapter({ skipPromotions: true, skipSocial: false });
    const items = await adapter.fetchNew(TEST_USER_ID);

    expect(items).toHaveLength(0);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("skipped"),
      expect.objectContaining({ id: "msg-1" })
    );
  });

  it("skips CATEGORY_SOCIAL when skipSocial=true", async () => {
    const msg = makeMessage("msg-1", {
      labelIds: ["INBOX", "CATEGORY_SOCIAL"],
    });
    (client.listMessageIds as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [{ id: "msg-1", threadId: "t-1" }],
      resultSizeEstimate: 1,
    });
    (client.getMessage as ReturnType<typeof vi.fn>).mockResolvedValue(msg);

    const adapter = createAdapter({ skipPromotions: false, skipSocial: true });
    const items = await adapter.fetchNew(TEST_USER_ID);

    expect(items).toHaveLength(0);
  });

  it("includes CATEGORY_PROMOTIONS when skipPromotions=false", async () => {
    const msg = makeMessage("msg-1", {
      labelIds: ["INBOX", "CATEGORY_PROMOTIONS"],
    });
    (client.listMessageIds as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [{ id: "msg-1", threadId: "t-1" }],
      resultSizeEstimate: 1,
    });
    (client.getMessage as ReturnType<typeof vi.fn>).mockResolvedValue(msg);

    const adapter = createAdapter({ skipPromotions: false, skipSocial: false });
    const items = await adapter.fetchNew(TEST_USER_ID);

    expect(items).toHaveLength(1);
  });

  it("includes CATEGORY_SOCIAL when skipSocial=false", async () => {
    const msg = makeMessage("msg-1", {
      labelIds: ["INBOX", "CATEGORY_SOCIAL"],
    });
    (client.listMessageIds as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [{ id: "msg-1", threadId: "t-1" }],
      resultSizeEstimate: 1,
    });
    (client.getMessage as ReturnType<typeof vi.fn>).mockResolvedValue(msg);

    const adapter = createAdapter({ skipPromotions: false, skipSocial: false });
    const items = await adapter.fetchNew(TEST_USER_ID);

    expect(items).toHaveLength(1);
  });

  // ── Persistent sync state ──────────────────────────────

  it("stores last sync epoch in PreferenceRepository after successful fetch", async () => {
    const msg = makeMessage("msg-1", { internalDate: "1705312800000" });
    (client.listMessageIds as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [{ id: "msg-1", threadId: "t-1" }],
      resultSizeEstimate: 1,
    });
    (client.getMessage as ReturnType<typeof vi.fn>).mockResolvedValue(msg);

    const adapter = createAdapter();
    await adapter.fetchNew(TEST_USER_ID);

    expect(prefRepo.set).toHaveBeenCalledWith(
      `gmail:lastSyncEpoch:${TEST_USER_ID}`,
      expect.any(String)
    );
    // Should store the epoch seconds of the most recent message
    const storedValue = (prefRepo.set as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(Number(storedValue)).toBeGreaterThan(0);
  });

  it("uses stored sync epoch to build `after:` query parameter", async () => {
    // Pre-seed the preference store with a last sync epoch
    prefRepo.set(`gmail:lastSyncEpoch:${TEST_USER_ID}`, "1705312800");

    (client.listMessageIds as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [],
      resultSizeEstimate: 0,
    });

    const adapter = createAdapter();
    await adapter.fetchNew(TEST_USER_ID);

    const callArgs = (client.listMessageIds as ReturnType<typeof vi.fn>).mock.calls[0][0] as ListMessageIdsOptions;
    expect(callArgs.q).toContain("after:1705312800");
  });

  it("does not set `after:` on first-ever poll (no stored state)", async () => {
    (client.listMessageIds as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [],
      resultSizeEstimate: 0,
    });

    const adapter = createAdapter();
    await adapter.fetchNew(TEST_USER_ID);

    const callArgs = (client.listMessageIds as ReturnType<typeof vi.fn>).mock.calls[0][0] as ListMessageIdsOptions;
    expect(callArgs.q).toBeUndefined();
  });

  it("does not update sync state when no new messages found", async () => {
    (client.listMessageIds as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [],
      resultSizeEstimate: 0,
    });

    const adapter = createAdapter();
    await adapter.fetchNew(TEST_USER_ID);

    // set should not be called for sync epoch (may be called during setup)
    const syncCalls = (prefRepo.set as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => (call[0] as string).startsWith("gmail:lastSyncEpoch:")
    );
    expect(syncCalls).toHaveLength(0);
  });

  // ── Multiple messages ──────────────────────────────────

  it("processes multiple messages and returns all valid ones", async () => {
    const msg1 = makeMessage("msg-1");
    const msg2 = makeMessage("msg-2");
    const msg3 = makeMessage("msg-3", {
      labelIds: ["INBOX", "CATEGORY_PROMOTIONS"],
    });

    (client.listMessageIds as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [
        { id: "msg-1", threadId: "t-1" },
        { id: "msg-2", threadId: "t-2" },
        { id: "msg-3", threadId: "t-3" },
      ],
      resultSizeEstimate: 3,
    });
    (client.getMessage as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(msg1)
      .mockResolvedValueOnce(msg2)
      .mockResolvedValueOnce(msg3);

    const adapter = createAdapter({ skipPromotions: true, skipSocial: true });
    const items = await adapter.fetchNew(TEST_USER_ID);

    expect(items).toHaveLength(2);
    expect(items[0].externalId).toBe("msg-1");
    expect(items[1].externalId).toBe("msg-2");
  });

  // ── maxResults config ──────────────────────────────────

  it("passes maxResults to listMessageIds", async () => {
    (client.listMessageIds as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [],
      resultSizeEstimate: 0,
    });

    const adapter = createAdapter(DEFAULT_SKIP, 50);
    await adapter.fetchNew(TEST_USER_ID);

    const callArgs = (client.listMessageIds as ReturnType<typeof vi.fn>).mock.calls[0][0] as ListMessageIdsOptions;
    expect(callArgs.maxResults).toBe(50);
  });

  // ── Error handling ─────────────────────────────────────

  it("propagates listMessageIds errors", async () => {
    (client.listMessageIds as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Gmail API error 401")
    );

    const adapter = createAdapter();
    await expect(adapter.fetchNew(TEST_USER_ID)).rejects.toThrow("Gmail API error 401");
  });

  it("logs and skips individual message fetch failures", async () => {
    const msg2 = makeMessage("msg-2");
    (client.listMessageIds as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [
        { id: "msg-1", threadId: "t-1" },
        { id: "msg-2", threadId: "t-2" },
      ],
      resultSizeEstimate: 2,
    });
    (client.getMessage as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("transient error"))
      .mockResolvedValueOnce(msg2);

    const adapter = createAdapter();
    const items = await adapter.fetchNew(TEST_USER_ID);

    expect(items).toHaveLength(1);
    expect(items[0].externalId).toBe("msg-2");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("fetch failed"),
      expect.objectContaining({ id: "msg-1" })
    );
  });

  // ── Header extraction edge cases ───────────────────────

  it("defaults to empty string when From header is missing", async () => {
    const msg = makeMessage("msg-1", {
      payload: {
        headers: [{ name: "Subject", value: "No From" }],
      },
    });
    (client.listMessageIds as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [{ id: "msg-1", threadId: "t-1" }],
      resultSizeEstimate: 1,
    });
    (client.getMessage as ReturnType<typeof vi.fn>).mockResolvedValue(msg);

    const adapter = createAdapter();
    const [item] = await adapter.fetchNew(TEST_USER_ID);

    expect(item.from).toBe("");
  });

  it("defaults to '(no subject)' when Subject header is missing", async () => {
    const msg = makeMessage("msg-1", {
      payload: {
        headers: [{ name: "From", value: "alice@test.com" }],
      },
    });
    (client.listMessageIds as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [{ id: "msg-1", threadId: "t-1" }],
      resultSizeEstimate: 1,
    });
    (client.getMessage as ReturnType<typeof vi.fn>).mockResolvedValue(msg);

    const adapter = createAdapter();
    const [item] = await adapter.fetchNew(TEST_USER_ID);

    expect(item.subject).toBe("(no subject)");
  });

  // ── INBOX label filter on listing ──────────────────────

  it("requests only INBOX label in listMessageIds", async () => {
    (client.listMessageIds as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [],
      resultSizeEstimate: 0,
    });

    const adapter = createAdapter();
    await adapter.fetchNew(TEST_USER_ID);

    const callArgs = (client.listMessageIds as ReturnType<typeof vi.fn>).mock.calls[0][0] as ListMessageIdsOptions;
    expect(callArgs.labelIds).toEqual(["INBOX"]);
  });

  // ── Same-timestamp cursor correctness ──────────────────

  it("stores epoch seconds MINUS 1 to avoid skipping same-second messages", async () => {
    // Two messages at exactly the same timestamp
    const epoch = "1705312800000"; // 2024-01-15T10:00:00Z → 1705312800 seconds
    const msg1 = makeMessage("msg-1", { internalDate: epoch });
    // msg2 exists conceptually but isn't needed in this first-poll-only test

    // First poll: only msg-1 is listed
    (client.listMessageIds as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      messages: [{ id: "msg-1", threadId: "t-1" }],
      resultSizeEstimate: 1,
    });
    (client.getMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce(msg1);

    const adapter = createAdapter();
    await adapter.fetchNew(TEST_USER_ID);

    // Cursor should be stored as epoch - 1 to keep the `after:` bound inclusive
    const syncCalls = (prefRepo.set as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => (call[0] as string).startsWith("gmail:lastSyncEpoch:")
    );
    expect(syncCalls).toHaveLength(1);
    const storedEpoch = Number(syncCalls[0][1]);
    // Must be 1705312799 (one second before), NOT 1705312800
    // Gmail `after:` is EXCLUSIVE — `after:X` returns messages with date > X
    // So we subtract 1 to also re-fetch messages at the exact same second
    expect(storedEpoch).toBe(1705312799);
  });

  it("re-fetches same-second messages on next poll (seen-ID dedup handles duplicates)", async () => {
    const epoch = "1705312800000";
    const msg1 = makeMessage("msg-1", { internalDate: epoch });
    const msg2 = makeMessage("msg-2", { internalDate: epoch });

    // First poll: msg-1 listed
    (client.listMessageIds as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      messages: [{ id: "msg-1", threadId: "t-1" }],
      resultSizeEstimate: 1,
    });
    (client.getMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce(msg1);

    const adapter = createAdapter();
    const first = await adapter.fetchNew(TEST_USER_ID);
    expect(first).toHaveLength(1);

    // Second poll: both msg-1 AND msg-2 appear (because after: is N-1)
    (client.listMessageIds as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      messages: [
        { id: "msg-1", threadId: "t-1" },
        { id: "msg-2", threadId: "t-2" },
      ],
      resultSizeEstimate: 2,
    });
    (client.getMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce(msg2);

    const second = await adapter.fetchNew(TEST_USER_ID);
    expect(second).toHaveLength(1);
    expect(second[0].externalId).toBe("msg-2");
    // getMessage only called once for msg-2 (msg-1 filtered by seen-ID before fetch)
    expect(client.getMessage).toHaveBeenCalledTimes(2); // 1 from first + 1 from second
  });

  // ── First poll: no-bound with full cursor lifecycle ────

  it("first poll has no query bound, ingests messages, and sets cursor for next poll", async () => {
    const epoch = "1705312800000";
    const msg = makeMessage("msg-1", { internalDate: epoch });

    (client.listMessageIds as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      messages: [{ id: "msg-1", threadId: "t-1" }],
      resultSizeEstimate: 1,
    });
    (client.getMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce(msg);

    const adapter = createAdapter();

    // First poll
    const items = await adapter.fetchNew(TEST_USER_ID);
    expect(items).toHaveLength(1);

    // Verify no `after:` on first call
    const firstCallArgs = (client.listMessageIds as ReturnType<typeof vi.fn>).mock.calls[0][0] as ListMessageIdsOptions;
    expect(firstCallArgs.q).toBeUndefined();

    // Verify cursor was stored
    expect(prefRepo.get(`gmail:lastSyncEpoch:${TEST_USER_ID}`)).not.toBeNull();

    // Second poll should use the cursor
    (client.listMessageIds as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      messages: [],
      resultSizeEstimate: 0,
    });
    await adapter.fetchNew(TEST_USER_ID);

    const secondCallArgs = (client.listMessageIds as ReturnType<typeof vi.fn>).mock.calls[1][0] as ListMessageIdsOptions;
    expect(secondCallArgs.q).toContain("after:");
    expect(secondCallArgs.q).toContain("1705312799"); // epoch - 1
  });
});
