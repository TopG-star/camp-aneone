import type { PersonalMemoryNote } from "../entities.js";

export interface PersonalMemoryNoteRepository {
  create(input: {
    userId: string;
    title: string;
    content: string;
    tags: string;
    pinned: boolean;
  }): PersonalMemoryNote;
  findById(id: string, userId: string): PersonalMemoryNote | null;
  list(userId: string, limit: number): PersonalMemoryNote[];
  search(userId: string, query: string, limit: number): PersonalMemoryNote[];
  update(
    id: string,
    userId: string,
    patch: {
      title?: string;
      content?: string;
      tags?: string;
      pinned?: boolean;
    },
  ): PersonalMemoryNote | null;
  delete(id: string, userId: string): boolean;
}
