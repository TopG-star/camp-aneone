import type { Source, Category, Priority } from "./enums.js";

export interface InboundItem {
  id: string;
  userId: string | null;
  source: Source;
  externalId: string;
  from: string;
  subject: string;
  bodyPreview: string;
  receivedAt: string; // ISO-8601
  rawJson: string;
  threadId: string | null;
  labels: string; // JSON array string
  classifiedAt: string | null;
  classifyAttempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface Classification {
  id: string;
  userId: string | null;
  inboundItemId: string;
  category: Category;
  priority: Priority;
  summary: string;
  actionItems: string; // JSON array string
  followUpNeeded: boolean;
  model: string;
  promptVersion: string;
  createdAt: string;
}

export interface Deadline {
  id: string;
  userId: string | null;
  inboundItemId: string;
  dueDate: string; // ISO-8601
  description: string;
  confidence: number; // 0.0–1.0
  status: "open" | "done" | "dismissed";
  createdAt: string;
  updatedAt: string;
}

export interface ActionLogEntry {
  id: string;
  userId: string | null;
  resourceId: string;
  actionType: string;
  riskLevel: "auto" | "approval_required";
  status: "proposed" | "approved" | "executed" | "rejected" | "rolled_back";
  payloadJson: string;
  resultJson: string | null;
  errorJson: string | null;
  rollbackJson: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Notification {
  id: string;
  userId: string | null;
  eventType: string;
  title: string;
  body: string;
  deepLink: string | null;
  read: boolean;
  createdAt: string;
}

export interface ConversationMessage {
  id: string;
  userId: string | null;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  toolCalls: string | null; // JSON string of executed tools
  createdAt: string;
}

export interface Preference {
  key: string;
  value: string;
  updatedAt: string;
}

export interface PushSubscription {
  id: string;
  endpoint: string;
  keysJson: string;
  createdAt: string;
}

export interface ClassificationFeedback {
  id: string;
  classificationId: string;
  correctedCategory: Category | null;
  correctedPriority: Priority | null;
  notes: string | null;
  createdAt: string;
}

export interface User {
  id: string;
  email: string;
  createdAt: string;
}

export type OAuthProvider = "google" | "github";

export interface OAuthToken {
  provider: OAuthProvider;
  userId: string;
  accessToken: string;
  refreshToken: string | null;
  tokenType: string;
  scope: string;
  expiresAt: string | null;
  providerEmail: string | null;
  createdAt: string;
  updatedAt: string;
}
