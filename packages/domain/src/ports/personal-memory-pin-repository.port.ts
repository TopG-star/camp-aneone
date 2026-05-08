import type { PersonalMemoryPin } from "../entities.js";

export interface PersonalMemoryPinRepository {
  create(input: {
    userId: string;
    sourceMessageId: string | null;
    conversationId: string | null;
    content: string;
  }): PersonalMemoryPin;
  findBySourceMessageId(
    userId: string,
    sourceMessageId: string,
  ): PersonalMemoryPin | null;
  list(userId: string, limit: number): PersonalMemoryPin[];
  search(userId: string, query: string, limit: number): PersonalMemoryPin[];
  delete(id: string, userId: string): boolean;
}
