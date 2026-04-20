/**
 * Minimal type definitions for the Gmail API v1 responses.
 * Only the fields we actually consume are typed.
 * @see https://developers.google.com/gmail/api/reference/rest
 */

// ── messages.list ──────────────────────────────────────────

export interface GmailListResponse {
  messages?: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

// ── messages.get (format=metadata) ─────────────────────────

export interface GmailMessageResource {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  internalDate: string; // epoch ms as string
  payload: {
    headers: Array<{ name: string; value: string }>;
  };
}

// ── Well-known Gmail category labels ───────────────────────

export const GMAIL_SKIP_LABELS = {
  CATEGORY_PROMOTIONS: "CATEGORY_PROMOTIONS",
  CATEGORY_SOCIAL: "CATEGORY_SOCIAL",
  CATEGORY_UPDATES: "CATEGORY_UPDATES",
  CATEGORY_FORUMS: "CATEGORY_FORUMS",
} as const;

// ── Adapter configuration ──────────────────────────────────

export interface GmailSkipConfig {
  skipPromotions: boolean;
  skipSocial: boolean;
}

// ── Parsed message (adapter-internal) ──────────────────────

export interface ParsedGmailMessage {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  receivedAt: string; // ISO-8601
  messageId: string; // RFC 2822 Message-Id header
  labelIds: string[];
}
