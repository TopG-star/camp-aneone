// ── Source Enum ───────────────────────────────────────────────
export const Source = {
  Gmail: "gmail",
  Outlook: "outlook",
  Teams: "teams",
  GitHub: "github",
} as const;
export type Source = (typeof Source)[keyof typeof Source];

// ── Category Enum ────────────────────────────────────────────
export const Category = {
  Urgent: "urgent",
  Work: "work",
  Personal: "personal",
  Newsletter: "newsletter",
  Transactional: "transactional",
  Spam: "spam",
} as const;
export type Category = (typeof Category)[keyof typeof Category];

// ── Priority ─────────────────────────────────────────────────
// 1 = most urgent … 5 = least
export type Priority = 1 | 2 | 3 | 4 | 5;

// ── Action Type Enum ─────────────────────────────────────────
export const ActionType = {
  Archive: "archive",
  Delete: "delete",
  DraftReply: "draft_reply",
  Send: "send",
  Forward: "forward",
  CreateReminder: "create_reminder",
  Notify: "notify",
  Classify: "classify",
  Label: "label",
} as const;
export type ActionType = (typeof ActionType)[keyof typeof ActionType];

// ── Risk Level Enum ──────────────────────────────────────────
export const RiskLevel = {
  Auto: "auto",
  ApprovalRequired: "approval_required",
} as const;
export type RiskLevel = (typeof RiskLevel)[keyof typeof RiskLevel];

// ── Action Status Enum ───────────────────────────────────────
// Forward-only: Proposed → Approved → Executed | Proposed → Rejected | Executed → RolledBack
export const ActionStatus = {
  Proposed: "proposed",
  Approved: "approved",
  Executed: "executed",
  Rejected: "rejected",
  RolledBack: "rolled_back",
} as const;
export type ActionStatus = (typeof ActionStatus)[keyof typeof ActionStatus];

// ── Deadline Status Enum ─────────────────────────────────────
export const DeadlineStatus = {
  Open: "open",
  Done: "done",
  Dismissed: "dismissed",
} as const;
export type DeadlineStatus =
  (typeof DeadlineStatus)[keyof typeof DeadlineStatus];

// ── Notification Event Type ──────────────────────────────────
export const NotificationEventType = {
  UrgentItem: "urgent_item",
  DeadlineApproaching: "deadline_approaching",
  ActionProposed: "action_proposed",
  ActionExecuted: "action_executed",
} as const;
export type NotificationEventType =
  (typeof NotificationEventType)[keyof typeof NotificationEventType];

// ── Conversation Role ────────────────────────────────────────
export const ConversationRole = {
  User: "user",
  Assistant: "assistant",
  System: "system",
} as const;
export type ConversationRole =
  (typeof ConversationRole)[keyof typeof ConversationRole];
