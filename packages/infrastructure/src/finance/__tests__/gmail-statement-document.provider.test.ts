import { describe, expect, it, vi } from "vitest";
import type { Logger } from "@oneon/domain";

import { GmailStatementDocumentProvider } from "../gmail-statement-document.provider.js";

function createLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

const statement = {
  id: "s1",
  userId: "u1",
  source: "gmail" as const,
  externalId: "ext-s1",
  messageId: "msg-s1",
  threadId: "thread-s1",
  sender: "alerts@chase.com",
  senderDomain: "chase.com",
  subject: "Statement",
  receivedAt: "2026-05-01T09:00:00.000Z",
  status: "discovered" as const,
  detectionRuleVersion: "fin-001c-v1",
  createdAt: "2026-05-01T09:00:00.000Z",
  updatedAt: "2026-05-01T09:00:00.000Z",
};

describe("GmailStatementDocumentProvider", () => {
  it("loads and decodes the first supported attachment", async () => {
    const client = {
      getMessageFull: vi.fn().mockResolvedValue({
        id: "msg-s1",
        threadId: "thread-s1",
        payload: {
          mimeType: "multipart/mixed",
          headers: [],
          parts: [
            {
              partId: "1",
              mimeType: "application/pdf",
              filename: "statement.pdf",
              body: {
                attachmentId: "att-1",
              },
            },
          ],
        },
      }),
      getMessageAttachment: vi.fn().mockResolvedValue({
        size: 5,
        data: "aGVsbG8",
      }),
    };

    const provider = new GmailStatementDocumentProvider({
      client,
      logger: createLogger(),
    });

    const document = await provider.getStatementDocument(statement);

    expect(document).not.toBeNull();
    expect(document?.mimeType).toBe("application/pdf");
    expect(document?.fileName).toBe("statement.pdf");
    expect(new TextDecoder().decode(document?.content)).toBe("hello");
    expect(client.getMessageAttachment).toHaveBeenCalledWith("msg-s1", "att-1");
  });

  it("returns inline attachment bytes when data is embedded", async () => {
    const client = {
      getMessageFull: vi.fn().mockResolvedValue({
        id: "msg-s1",
        threadId: "thread-s1",
        payload: {
          mimeType: "multipart/mixed",
          headers: [],
          parts: [
            {
              partId: "1",
              mimeType: "text/plain",
              filename: "statement.txt",
              body: {
                size: 5,
                data: "d29ybGQ",
              },
            },
          ],
        },
      }),
      getMessageAttachment: vi.fn(),
    };

    const provider = new GmailStatementDocumentProvider({
      client,
      logger: createLogger(),
    });

    const document = await provider.getStatementDocument(statement);

    expect(document).not.toBeNull();
    expect(new TextDecoder().decode(document?.content)).toBe("world");
    expect(client.getMessageAttachment).not.toHaveBeenCalled();
  });

  it("returns null when no supported attachment is present", async () => {
    const client = {
      getMessageFull: vi.fn().mockResolvedValue({
        id: "msg-s1",
        threadId: "thread-s1",
        payload: {
          mimeType: "multipart/mixed",
          headers: [],
          parts: [
            {
              partId: "1",
              mimeType: "image/png",
              filename: "preview.png",
              body: {
                attachmentId: "att-1",
              },
            },
          ],
        },
      }),
      getMessageAttachment: vi.fn(),
    };

    const provider = new GmailStatementDocumentProvider({
      client,
      logger: createLogger(),
    });

    const document = await provider.getStatementDocument(statement);

    expect(document).toBeNull();
  });
});
