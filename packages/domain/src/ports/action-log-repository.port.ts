import type { ActionLogEntry } from "../entities.js";
import type { ActionStatus, ActionType } from "../enums.js";

export interface ActionLogRepository {
  create(entry: Omit<ActionLogEntry, "id" | "createdAt" | "updatedAt">): ActionLogEntry;
  findByResourceAndType(resourceId: string, actionType: ActionType, userId?: string): ActionLogEntry | null;
  findByStatus(status: ActionStatus, limit?: number, userId?: string): ActionLogEntry[];
  updateStatus(
    id: string,
    status: ActionStatus,
    data?: { resultJson?: string; errorJson?: string; rollbackJson?: string }
  ): void;
  findAll(options: {
    status?: ActionStatus;
    actionType?: ActionType;
    limit?: number;
    offset?: number;
    userId?: string;
  }): ActionLogEntry[];
  count(options?: { status?: ActionStatus; userId?: string }): number;
}
