import { z } from "zod";

// ── POST /api/chat ───────────────────────────────────────────

export const ChatRequestSchema = z.object({
  message: z.string().min(1),
  conversationId: z.string().optional(),
});

export type ChatRequest = z.infer<typeof ChatRequestSchema>;

// ── Chat Message (in history) ────────────────────────────────

export const ChatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  createdAt: z.string(),
});

export type ChatMessage = z.infer<typeof ChatMessageSchema>;

// ── Chat Response ────────────────────────────────────────────

export const ChatResponseSchema = z.object({
  response: z.string(),
  userMessageId: z.string(),
  assistantMessageId: z.string(),
  conversationId: z.string(),
  history: z.array(ChatMessageSchema),
});

export type ChatResponse = z.infer<typeof ChatResponseSchema>;
