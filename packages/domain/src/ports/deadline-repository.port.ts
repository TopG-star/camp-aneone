import type { Deadline } from "../entities.js";
import type { DeadlineStatus } from "../enums.js";

export interface DeadlineRepository {
  create(deadline: Omit<Deadline, "id" | "createdAt" | "updatedAt">): Deadline;
  findByInboundItemId(inboundItemId: string): Deadline[];
  findByDateRange(from: string, to: string, status?: DeadlineStatus, userId?: string): Deadline[];
  findOverdue(userId?: string): Deadline[];
  updateStatus(id: string, status: DeadlineStatus): void;
  count(options?: { status?: DeadlineStatus; userId?: string }): number;
}
