import type {
  BankStatement,
  Logger,
  StatementDocument,
  StatementDocumentProvider,
} from "@oneon/domain";

import type {
  GmailMessageAttachmentResource,
  GmailMessageFullResource,
  GmailMessagePart,
} from "../gmail/gmail.types.js";

const DEFAULT_SUPPORTED_MIME_TYPES = [
  "application/pdf",
  "text/plain",
  "text/csv",
] as const;

const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface GmailStatementDocumentClient {
  getMessageFull(messageId: string): Promise<GmailMessageFullResource>;
  getMessageAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<GmailMessageAttachmentResource>;
}

export interface GmailStatementDocumentProviderDeps {
  client: GmailStatementDocumentClient;
  logger?: Logger;
  supportedMimeTypes?: string[];
}

export class GmailStatementDocumentProvider implements StatementDocumentProvider {
  private readonly client: GmailStatementDocumentClient;
  private readonly logger: Logger;
  private readonly supportedMimeTypes: Set<string>;

  constructor(deps: GmailStatementDocumentProviderDeps) {
    this.client = deps.client;
    this.logger = deps.logger ?? NOOP_LOGGER;
    this.supportedMimeTypes = new Set(
      (deps.supportedMimeTypes ?? [...DEFAULT_SUPPORTED_MIME_TYPES]).map(
        (mime) => mime.trim().toLowerCase(),
      ),
    );
  }

  async getStatementDocument(
    statement: BankStatement,
  ): Promise<StatementDocument | null> {
    if (statement.source !== "gmail") {
      return null;
    }

    try {
      const message = await this.client.getMessageFull(statement.messageId);
      const part = findFirstAttachmentPart(
        message.payload,
        this.supportedMimeTypes,
      );

      if (!part || !part.mimeType) {
        return null;
      }

      const base64Data = await this.getAttachmentData(statement.messageId, part);
      if (!base64Data) {
        return null;
      }

      return {
        mimeType: part.mimeType,
        fileName: part.filename || null,
        content: decodeBase64Url(base64Data),
      };
    } catch (error) {
      this.logger.warn("Gmail statement document fetch failed", {
        statementId: statement.id,
        messageId: statement.messageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async getAttachmentData(
    messageId: string,
    part: GmailMessagePart,
  ): Promise<string | null> {
    if (part.body?.data) {
      return part.body.data;
    }

    if (!part.body?.attachmentId) {
      return null;
    }

    const attachment = await this.client.getMessageAttachment(
      messageId,
      part.body.attachmentId,
    );

    return attachment.data ?? null;
  }
}

function findFirstAttachmentPart(
  root: GmailMessagePart | undefined,
  supportedMimeTypes: Set<string>,
): GmailMessagePart | null {
  if (!root) {
    return null;
  }

  const queue: GmailMessagePart[] = [root];

  while (queue.length > 0) {
    const current = queue.shift()!;

    const mimeType = current.mimeType?.toLowerCase();
    const hasData = !!current.body?.data || !!current.body?.attachmentId;

    if (mimeType && hasData && supportedMimeTypes.has(mimeType)) {
      return current;
    }

    if (current.parts && current.parts.length > 0) {
      queue.push(...current.parts);
    }
  }

  return null;
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + "=".repeat(padding);
  const buffer = Buffer.from(padded, "base64");
  return new Uint8Array(buffer);
}
