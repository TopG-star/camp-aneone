import type { ConversationMessage } from "../entities.js";

export interface ConversationRepository {
  append(message: Omit<ConversationMessage, "id" | "createdAt">): ConversationMessage;
  findRecentByConversation(conversationId: string, limit: number, userId?: string): ConversationMessage[];
  countByConversation(conversationId: string): number;
  count(userId?: string): number;
}
