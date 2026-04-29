import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach } from "vitest";

import { SqliteInboundItemRepository } from "./repositories/sqlite-inbound-item.repository.js";
import { SqliteClassificationRepository, SqliteClassificationFeedbackRepository } from "./repositories/sqlite-classification.repository.js";
import { SqliteDeadlineRepository } from "./repositories/sqlite-deadline.repository.js";
import { SqliteActionLogRepository } from "./repositories/sqlite-action-log.repository.js";
import { SqliteNotificationRepository } from "./repositories/sqlite-notification.repository.js";
import { SqliteConversationRepository } from "./repositories/sqlite-conversation.repository.js";
import { SqlitePreferenceRepository } from "./repositories/sqlite-preference.repository.js";
import type { Source } from "@oneon/domain";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Apply migrations in order
  const migrationsDir = join(__dirname, "migrations");
  const migration1 = readFileSync(join(migrationsDir, "001_initial_schema.sql"), "utf-8");
  const migration2 = readFileSync(join(migrationsDir, "002_add_thread_id_labels.sql"), "utf-8");
  const migration3 = readFileSync(join(migrationsDir, "003_add_classify_attempts.sql"), "utf-8");
  const migration4 = readFileSync(join(migrationsDir, "004_add_conversation_id.sql"), "utf-8");
  const migration5 = readFileSync(join(migrationsDir, "005_users_and_oauth_tokens.sql"), "utf-8");
  const migration6 = readFileSync(join(migrationsDir, "006_add_user_id_to_core_tables.sql"), "utf-8");
  const migration7 = readFileSync(join(migrationsDir, "007_user_profiles.sql"), "utf-8");
  const migration8 = readFileSync(join(migrationsDir, "008_bank_statement_intake.sql"), "utf-8");
  db.exec(migration1);
  db.exec(migration2);
  db.exec(migration3);
  db.exec(migration4);
  db.exec(migration5);
  db.exec(migration6);
  db.exec(migration7);
  db.exec(migration8);

  return db;
}

// ── InboundItemRepository ────────────────────────────────────

describe("SqliteInboundItemRepository", () => {
  let db: Database.Database;
  let repo: SqliteInboundItemRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteInboundItemRepository(db);
  });

  it("creates and retrieves an item", () => {
    const item = repo.upsert({
      userId: null,
      source: "gmail" as Source,
      externalId: "ext-1",
      from: "alice@test.com",
      subject: "Hello",
      bodyPreview: "Preview text",
      receivedAt: "2026-04-14T10:00:00Z",
      rawJson: "{}",
      threadId: "thread-1",
      labels: '["inbox"]',
      classifiedAt: null,
      classifyAttempts: 0,
    });

    expect(item.id).toBeTruthy();
    expect(item.source).toBe("gmail");
    expect(item.externalId).toBe("ext-1");
    expect(item.from).toBe("alice@test.com");
    expect(item.threadId).toBe("thread-1");
    expect(item.labels).toBe('["inbox"]');

    const found = repo.findById(item.id);
    expect(found).toEqual(item);
  });

  it("upsert updates changed fields on conflict", () => {
    const item1 = repo.upsert({
      userId: null,
      source: "gmail" as Source,
      externalId: "ext-1",
      from: "alice@test.com",
      subject: "Hello",
      bodyPreview: "Old preview",
      receivedAt: "2026-04-14T10:00:00Z",
      rawJson: "{}",
      threadId: null,
      labels: "[]",
      classifiedAt: null,
      classifyAttempts: 0,
    });

    const item2 = repo.upsert({
      userId: null,
      source: "gmail" as Source,
      externalId: "ext-1",
      from: "alice@test.com",
      subject: "Hello Updated",
      bodyPreview: "New preview",
      receivedAt: "2026-04-14T10:00:00Z",
      rawJson: '{"updated":true}',
      threadId: "thread-1",
      labels: '["inbox"]',
      classifiedAt: null,
      classifyAttempts: 0,
    });

    expect(item2.subject).toBe("Hello Updated");
    expect(item2.bodyPreview).toBe("New preview");
    expect(item2.threadId).toBe("thread-1");
    expect(item2.labels).toBe('["inbox"]');
    expect(item2.createdAt).toBe(item1.createdAt);
  });

  it("findBySourceAndExternalId returns null for missing", () => {
    const found = repo.findBySourceAndExternalId("gmail" as Source, "nope");
    expect(found).toBeNull();
  });

  it("findUnclassified returns only unclassified items", () => {
    repo.upsert({
      userId: null,
      source: "gmail" as Source,
      externalId: "ext-1",
      from: "a@test.com",
      subject: "Unclassified",
      bodyPreview: "",
      receivedAt: "2026-04-14T10:00:00Z",
      rawJson: "{}",
      threadId: null,
      labels: "[]",
      classifiedAt: null,
      classifyAttempts: 0,
    });
    repo.upsert({
      userId: null,
      source: "gmail" as Source,
      externalId: "ext-2",
      from: "b@test.com",
      subject: "Classified",
      bodyPreview: "",
      receivedAt: "2026-04-14T11:00:00Z",
      rawJson: "{}",
      threadId: null,
      labels: "[]",
      classifiedAt: "2026-04-14T12:00:00Z",
      classifyAttempts: 0,
    });

    const unclassified = repo.findUnclassified(10);
    expect(unclassified).toHaveLength(1);
    expect(unclassified[0].subject).toBe("Unclassified");
  });

  it("markClassified sets classified_at", () => {
    const item = repo.upsert({
      userId: null,
      source: "gmail" as Source,
      externalId: "ext-1",
      from: "a@test.com",
      subject: "Test",
      bodyPreview: "",
      receivedAt: "2026-04-14T10:00:00Z",
      rawJson: "{}",
      threadId: null,
      labels: "[]",
      classifiedAt: null,
      classifyAttempts: 0,
    });

    repo.markClassified(item.id);
    const updated = repo.findById(item.id)!;
    expect(updated.classifiedAt).toBeTruthy();
  });

  it("findAll with limit:0 returns zero rows", () => {
    repo.upsert({
      userId: null,
      source: "gmail" as Source,
      externalId: "ext-1",
      from: "a@test.com",
      subject: "Test",
      bodyPreview: "",
      receivedAt: "2026-04-14T10:00:00Z",
      rawJson: "{}",
      threadId: null,
      labels: "[]",
      classifiedAt: null,
      classifyAttempts: 0,
    });

    const results = repo.findAll({ limit: 0 });
    expect(results).toHaveLength(0);
  });

  it("count returns correct count", () => {
    expect(repo.count()).toBe(0);

    repo.upsert({
      userId: null,
      source: "gmail" as Source,
      externalId: "ext-1",
      from: "a@test.com",
      subject: "Test",
      bodyPreview: "",
      receivedAt: "2026-04-14T10:00:00Z",
      rawJson: "{}",
      threadId: null,
      labels: "[]",
      classifiedAt: null,
      classifyAttempts: 0,
    });

    expect(repo.count()).toBe(1);
    expect(repo.count({ source: "gmail" as Source })).toBe(1);
    expect(repo.count({ source: "outlook" as Source })).toBe(0);
  });

  it("search matches subject", () => {
    repo.upsert({
      userId: null,
      source: "gmail" as Source,
      externalId: "ext-1",
      from: "a@test.com",
      subject: "Quarterly report deadline extension",
      bodyPreview: "Please review.",
      receivedAt: "2026-04-14T10:00:00Z",
      rawJson: "{}",
      threadId: null,
      labels: "[]",
      classifiedAt: null,
      classifyAttempts: 0,
    });
    repo.upsert({
      userId: null,
      source: "gmail" as Source,
      externalId: "ext-2",
      from: "b@test.com",
      subject: "Lunch plans",
      bodyPreview: "Where should we eat?",
      receivedAt: "2026-04-14T11:00:00Z",
      rawJson: "{}",
      threadId: null,
      labels: "[]",
      classifiedAt: null,
      classifyAttempts: 0,
    });

    const results = repo.search({ query: "quarterly" });
    expect(results).toHaveLength(1);
    expect(results[0].subject).toContain("Quarterly");
  });

  it("search matches from field", () => {
    repo.upsert({
      userId: null,
      source: "outlook" as Source,
      externalId: "ext-1",
      from: "boss@company.com",
      subject: "Hello",
      bodyPreview: "Hi there.",
      receivedAt: "2026-04-14T10:00:00Z",
      rawJson: "{}",
      threadId: null,
      labels: "[]",
      classifiedAt: null,
      classifyAttempts: 0,
    });

    const results = repo.search({ query: "boss@company" });
    expect(results).toHaveLength(1);
  });

  it("search matches body_preview", () => {
    repo.upsert({
      userId: null,
      source: "gmail" as Source,
      externalId: "ext-1",
      from: "a@test.com",
      subject: "Hello",
      bodyPreview: "The budget spreadsheet is attached.",
      receivedAt: "2026-04-14T10:00:00Z",
      rawJson: "{}",
      threadId: null,
      labels: "[]",
      classifiedAt: null,
      classifyAttempts: 0,
    });

    const results = repo.search({ query: "spreadsheet" });
    expect(results).toHaveLength(1);
  });

  it("search filters by source", () => {
    repo.upsert({
      userId: null,
      source: "gmail" as Source,
      externalId: "ext-1",
      from: "a@test.com",
      subject: "Budget report",
      bodyPreview: "",
      receivedAt: "2026-04-14T10:00:00Z",
      rawJson: "{}",
      threadId: null,
      labels: "[]",
      classifiedAt: null,
      classifyAttempts: 0,
    });
    repo.upsert({
      userId: null,
      source: "outlook" as Source,
      externalId: "ext-2",
      from: "b@test.com",
      subject: "Budget report",
      bodyPreview: "",
      receivedAt: "2026-04-14T11:00:00Z",
      rawJson: "{}",
      threadId: null,
      labels: "[]",
      classifiedAt: null,
      classifyAttempts: 0,
    });

    const results = repo.search({ query: "budget", source: "outlook" as Source });
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe("outlook");
  });

  it("search respects limit", () => {
    for (let i = 0; i < 5; i++) {
      repo.upsert({
        userId: null,
        source: "gmail" as Source,
        externalId: `ext-${i}`,
        from: "a@test.com",
        subject: `Report item ${i}`,
        bodyPreview: "",
        receivedAt: `2026-04-14T${10 + i}:00:00Z`,
        rawJson: "{}",
        threadId: null,
        labels: "[]",
        classifiedAt: null,
        classifyAttempts: 0,
      });
    }

    const results = repo.search({ query: "report", limit: 3 });
    expect(results).toHaveLength(3);
  });
});

// ── ClassificationRepository ─────────────────────────────────

describe("SqliteClassificationRepository", () => {
  let db: Database.Database;
  let itemRepo: SqliteInboundItemRepository;
  let repo: SqliteClassificationRepository;

  beforeEach(() => {
    db = createTestDb();
    itemRepo = new SqliteInboundItemRepository(db);
    repo = new SqliteClassificationRepository(db);
  });

  function createInboundItem(externalId: string) {
    return itemRepo.upsert({
      userId: null,
      source: "gmail" as Source,
      externalId,
      from: "test@test.com",
      subject: "Test",
      bodyPreview: "",
      receivedAt: "2026-04-14T10:00:00Z",
      rawJson: "{}",
      threadId: null,
      labels: "[]",
      classifiedAt: null,
      classifyAttempts: 0,
    });
  }

  it("creates and retrieves a classification", () => {
    const item = createInboundItem("ext-1");
    const classification = repo.create({
      userId: null,
      inboundItemId: item.id,
      category: "work",
      priority: 2,
      summary: "Work email about project",
      actionItems: "[]",
      followUpNeeded: true,
      model: "claude-3-5-haiku",
      promptVersion: "v1",
    });

    expect(classification.id).toBeTruthy();
    expect(classification.category).toBe("work");
    expect(classification.priority).toBe(2);
    expect(classification.followUpNeeded).toBe(true);

    const found = repo.findByInboundItemId(item.id);
    expect(found).toEqual(classification);
  });

  it("findAll with limit:0 returns zero rows", () => {
    const item = createInboundItem("ext-1");
    repo.create({
      userId: null,
      inboundItemId: item.id,
      category: "work",
      priority: 3,
      summary: "Test",
      actionItems: "[]",
      followUpNeeded: false,
      model: "claude",
      promptVersion: "v1",
    });

    const results = repo.findAll({ limit: 0 });
    expect(results).toHaveLength(0);
  });

  it("count works correctly", () => {
    expect(repo.count()).toBe(0);

    const item = createInboundItem("ext-1");
    repo.create({
      userId: null,
      inboundItemId: item.id,
      category: "urgent",
      priority: 1,
      summary: "Urgent",
      actionItems: "[]",
      followUpNeeded: true,
      model: "claude",
      promptVersion: "v1",
    });

    expect(repo.count()).toBe(1);
    expect(repo.count({ category: "urgent" })).toBe(1);
    expect(repo.count({ category: "spam" })).toBe(0);
  });
});

// ── ClassificationFeedbackRepository ─────────────────────────

describe("SqliteClassificationFeedbackRepository", () => {
  let db: Database.Database;
  let repo: SqliteClassificationFeedbackRepository;

  beforeEach(() => {
    db = createTestDb();
    const itemRepo = new SqliteInboundItemRepository(db);
    const classRepo = new SqliteClassificationRepository(db);
    repo = new SqliteClassificationFeedbackRepository(db);

    const item = itemRepo.upsert({
      userId: null,
      source: "gmail" as Source,
      externalId: "ext-1",
      from: "test@test.com",
      subject: "Test",
      bodyPreview: "",
      receivedAt: "2026-04-14T10:00:00Z",
      rawJson: "{}",
      threadId: null,
      labels: "[]",
      classifiedAt: null,
      classifyAttempts: 0,
    });
    classRepo.create({
      userId: null,
      inboundItemId: item.id,
      category: "work",
      priority: 3,
      summary: "Test",
      actionItems: "[]",
      followUpNeeded: false,
      model: "claude",
      promptVersion: "v1",
    });
  });

  it("creates feedback and retrieves by classification id", () => {
    const classifications = db
      .prepare("SELECT id FROM classifications")
      .all() as { id: string }[];
    const classId = classifications[0].id;

    const feedback = repo.create({
      classificationId: classId,
      correctedCategory: "urgent",
      correctedPriority: 1,
      notes: "This was actually urgent",
    });

    expect(feedback.id).toBeTruthy();
    expect(feedback.correctedCategory).toBe("urgent");

    const found = repo.findByClassificationId(classId);
    expect(found).toHaveLength(1);
    expect(found[0]).toEqual(feedback);
  });
});

// ── DeadlineRepository ───────────────────────────────────────

describe("SqliteDeadlineRepository", () => {
  let db: Database.Database;
  let repo: SqliteDeadlineRepository;
  let itemId: string;

  beforeEach(() => {
    db = createTestDb();
    const itemRepo = new SqliteInboundItemRepository(db);
    repo = new SqliteDeadlineRepository(db);

    const item = itemRepo.upsert({
      userId: null,
      source: "gmail" as Source,
      externalId: "ext-1",
      from: "test@test.com",
      subject: "Test",
      bodyPreview: "",
      receivedAt: "2026-04-14T10:00:00Z",
      rawJson: "{}",
      threadId: null,
      labels: "[]",
      classifiedAt: null,
      classifyAttempts: 0,
    });
    itemId = item.id;
  });

  it("creates and retrieves a deadline", () => {
    const deadline = repo.create({
      userId: null,
      inboundItemId: itemId,
      dueDate: "2026-04-20T17:00:00Z",
      description: "Submit report",
      confidence: 0.9,
      status: "open",
    });

    expect(deadline.id).toBeTruthy();
    expect(deadline.dueDate).toBe("2026-04-20T17:00:00Z");
    expect(deadline.confidence).toBe(0.9);
    expect(deadline.status).toBe("open");

    const found = repo.findByInboundItemId(itemId);
    expect(found).toHaveLength(1);
    expect(found[0]).toEqual(deadline);
  });

  it("findByDateRange filters correctly", () => {
    repo.create({
      userId: null,
      inboundItemId: itemId,
      dueDate: "2026-04-20T17:00:00Z",
      description: "In range",
      confidence: 0.8,
      status: "open",
    });
    repo.create({
      userId: null,
      inboundItemId: itemId,
      dueDate: "2026-05-01T17:00:00Z",
      description: "Out of range",
      confidence: 0.7,
      status: "open",
    });

    const results = repo.findByDateRange("2026-04-15T00:00:00Z", "2026-04-25T00:00:00Z");
    expect(results).toHaveLength(1);
    expect(results[0].description).toBe("In range");
  });

  it("updateStatus changes the status", () => {
    const deadline = repo.create({
      userId: null,
      inboundItemId: itemId,
      dueDate: "2026-04-20T17:00:00Z",
      description: "Test",
      confidence: 0.5,
      status: "open",
    });

    repo.updateStatus(deadline.id, "done");
    const found = repo.findByInboundItemId(itemId);
    expect(found[0].status).toBe("done");
  });

  it("count works correctly", () => {
    expect(repo.count()).toBe(0);
    repo.create({
      userId: null,
      inboundItemId: itemId,
      dueDate: "2026-04-20T17:00:00Z",
      description: "Test",
      confidence: 0.5,
      status: "open",
    });
    expect(repo.count()).toBe(1);
    expect(repo.count({ status: "open" })).toBe(1);
    expect(repo.count({ status: "done" })).toBe(0);
  });
});

// ── ActionLogRepository ──────────────────────────────────────

describe("SqliteActionLogRepository", () => {
  let db: Database.Database;
  let repo: SqliteActionLogRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteActionLogRepository(db);
  });

  it("creates and retrieves an action log entry", () => {
    const entry = repo.create({
      userId: null,
      resourceId: "item-1",
      actionType: "archive",
      riskLevel: "auto",
      status: "proposed",
      payloadJson: "{}",
      resultJson: null,
      errorJson: null,
      rollbackJson: null,
    });

    expect(entry.id).toBeTruthy();
    expect(entry.status).toBe("proposed");
    expect(entry.actionType).toBe("archive");
  });

  it("state machine allows valid transition: proposed → approved", () => {
    const entry = repo.create({
      userId: null,
      resourceId: "item-1",
      actionType: "archive",
      riskLevel: "approval_required",
      status: "proposed",
      payloadJson: "{}",
      resultJson: null,
      errorJson: null,
      rollbackJson: null,
    });

    expect(() => {
      repo.updateStatus(entry.id, "approved" as any);
    }).not.toThrow();

    const found = repo.findByResourceAndType("item-1", "archive" as any);
    expect(found!.status).toBe("approved");
  });

  it("state machine allows valid transition: approved → executed", () => {
    const entry = repo.create({
      userId: null,
      resourceId: "item-1",
      actionType: "archive",
      riskLevel: "auto",
      status: "proposed",
      payloadJson: "{}",
      resultJson: null,
      errorJson: null,
      rollbackJson: null,
    });

    repo.updateStatus(entry.id, "approved" as any);
    repo.updateStatus(entry.id, "executed" as any, { resultJson: '{"ok":true}' });

    const found = repo.findByResourceAndType("item-1", "archive" as any);
    expect(found!.status).toBe("executed");
    expect(found!.resultJson).toBe('{"ok":true}');
  });

  it("state machine rejects invalid transition: proposed → executed", () => {
    const entry = repo.create({
      userId: null,
      resourceId: "item-1",
      actionType: "archive",
      riskLevel: "auto",
      status: "proposed",
      payloadJson: "{}",
      resultJson: null,
      errorJson: null,
      rollbackJson: null,
    });

    expect(() => {
      repo.updateStatus(entry.id, "executed" as any);
    }).toThrow("Invalid status transition: proposed → executed");
  });

  it("state machine rejects invalid transition: rejected → approved", () => {
    const entry = repo.create({
      userId: null,
      resourceId: "item-1",
      actionType: "archive",
      riskLevel: "auto",
      status: "proposed",
      payloadJson: "{}",
      resultJson: null,
      errorJson: null,
      rollbackJson: null,
    });

    repo.updateStatus(entry.id, "rejected" as any);

    expect(() => {
      repo.updateStatus(entry.id, "approved" as any);
    }).toThrow("Invalid status transition: rejected → approved");
  });

  it("updateStatus throws for non-existent entry", () => {
    expect(() => {
      repo.updateStatus("nonexistent-id", "approved" as any);
    }).toThrow("ActionLogEntry not found: nonexistent-id");
  });

  it("findAll with limit:0 returns zero rows", () => {
    repo.create({
      userId: null,
      resourceId: "item-1",
      actionType: "archive",
      riskLevel: "auto",
      status: "proposed",
      payloadJson: "{}",
      resultJson: null,
      errorJson: null,
      rollbackJson: null,
    });

    const results = repo.findAll({ limit: 0 });
    expect(results).toHaveLength(0);
  });

  it("count returns correct count", () => {
    expect(repo.count()).toBe(0);

    repo.create({
      userId: null,
      resourceId: "item-1",
      actionType: "archive",
      riskLevel: "auto",
      status: "proposed",
      payloadJson: "{}",
      resultJson: null,
      errorJson: null,
      rollbackJson: null,
    });

    expect(repo.count()).toBe(1);
    expect(repo.count({ status: "proposed" as any })).toBe(1);
    expect(repo.count({ status: "executed" as any })).toBe(0);
  });
});

// ── NotificationRepository ───────────────────────────────────

describe("SqliteNotificationRepository", () => {
  let db: Database.Database;
  let repo: SqliteNotificationRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteNotificationRepository(db);
  });

  it("creates and retrieves a notification", () => {
    const notif = repo.create({
      userId: null,
      eventType: "urgent_item",
      title: "Urgent email",
      body: "You have an urgent email",
      deepLink: "/inbox/123",
      read: false,
    });

    expect(notif.id).toBeTruthy();
    expect(notif.read).toBe(false);
    expect(notif.title).toBe("Urgent email");
  });

  it("findUnread returns only unread notifications", () => {
    repo.create({
      userId: null,
      eventType: "urgent_item",
      title: "Unread",
      body: "",
      deepLink: null,
      read: false,
    });
    repo.create({
      userId: null,
      eventType: "action_executed",
      title: "Read",
      body: "",
      deepLink: null,
      read: true,
    });

    const unread = repo.findUnread();
    expect(unread).toHaveLength(1);
    expect(unread[0].title).toBe("Unread");
  });

  it("markRead marks a notification as read", () => {
    const notif = repo.create({
      userId: null,
      eventType: "urgent_item",
      title: "Test",
      body: "",
      deepLink: null,
      read: false,
    });

    repo.markRead(notif.id);
    const unread = repo.findUnread();
    expect(unread).toHaveLength(0);
  });

  it("markAllRead marks all as read", () => {
    repo.create({ userId: null, eventType: "a", title: "A", body: "", deepLink: null, read: false });
    repo.create({ userId: null, eventType: "b", title: "B", body: "", deepLink: null, read: false });

    repo.markAllRead();
    expect(repo.countUnread()).toBe(0);
  });

  it("findAll with limit:0 returns zero rows", () => {
    repo.create({ userId: null, eventType: "a", title: "A", body: "", deepLink: null, read: false });

    const results = repo.findAll({ limit: 0 });
    expect(results).toHaveLength(0);
  });

  it("countUnread returns correct count", () => {
    expect(repo.countUnread()).toBe(0);
    repo.create({ userId: null, eventType: "a", title: "A", body: "", deepLink: null, read: false });
    repo.create({ userId: null, eventType: "b", title: "B", body: "", deepLink: null, read: true });
    expect(repo.countUnread()).toBe(1);
  });
});

// ── ConversationRepository ───────────────────────────────────

describe("SqliteConversationRepository", () => {
  let db: Database.Database;
  let repo: SqliteConversationRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteConversationRepository(db);
  });

  it("appends and retrieves messages", () => {
    const msg = repo.append({
      userId: null,
      conversationId: "conv-001",
      role: "user",
      content: "Hello, Oneon!",
      toolCalls: null,
    });

    expect(msg.id).toBeTruthy();
    expect(msg.conversationId).toBe("conv-001");
    expect(msg.role).toBe("user");
    expect(msg.content).toBe("Hello, Oneon!");
  });

  it("findRecentByConversation returns messages in chronological order", () => {
    repo.append({ userId: null, conversationId: "conv-001", role: "user", content: "First", toolCalls: null });
    repo.append({ userId: null, conversationId: "conv-001", role: "assistant", content: "Second", toolCalls: null });
    repo.append({ userId: null, conversationId: "conv-001", role: "user", content: "Third", toolCalls: null });

    const recent = repo.findRecentByConversation("conv-001", 2);
    expect(recent).toHaveLength(2);
    expect(recent[0].content).toBe("Second");
    expect(recent[1].content).toBe("Third");
  });

  it("findRecentByConversation scopes to conversation", () => {
    repo.append({ userId: null, conversationId: "conv-A", role: "user", content: "Msg A", toolCalls: null });
    repo.append({ userId: null, conversationId: "conv-B", role: "user", content: "Msg B", toolCalls: null });

    const recentA = repo.findRecentByConversation("conv-A", 10);
    expect(recentA).toHaveLength(1);
    expect(recentA[0].content).toBe("Msg A");
  });

  it("countByConversation returns count for specific conversation", () => {
    repo.append({ userId: null, conversationId: "conv-A", role: "user", content: "Hello", toolCalls: null });
    repo.append({ userId: null, conversationId: "conv-B", role: "user", content: "World", toolCalls: null });

    expect(repo.countByConversation("conv-A")).toBe(1);
    expect(repo.countByConversation("conv-B")).toBe(1);
    expect(repo.count()).toBe(2);
  });

  it("count returns correct count", () => {
    expect(repo.count()).toBe(0);
    repo.append({ userId: null, conversationId: "conv-001", role: "user", content: "Hello", toolCalls: null });
    expect(repo.count()).toBe(1);
  });
});

// ── PreferenceRepository ─────────────────────────────────────

describe("SqlitePreferenceRepository", () => {
  let db: Database.Database;
  let repo: SqlitePreferenceRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqlitePreferenceRepository(db);
  });

  it("set and get a preference", () => {
    repo.set("theme", "dark");
    expect(repo.get("theme")).toBe("dark");
  });

  it("set overwrites existing preference", () => {
    repo.set("theme", "dark");
    repo.set("theme", "light");
    expect(repo.get("theme")).toBe("light");
  });

  it("get returns null for missing key", () => {
    expect(repo.get("nonexistent")).toBeNull();
  });

  it("getAll returns all preferences", () => {
    repo.set("theme", "dark");
    repo.set("lang", "en");
    const all = repo.getAll();
    expect(all).toHaveLength(2);
    expect(all.map((p) => p.key).sort()).toEqual(["lang", "theme"]);
  });

  it("delete removes a preference", () => {
    repo.set("theme", "dark");
    repo.delete("theme");
    expect(repo.get("theme")).toBeNull();
  });
});
