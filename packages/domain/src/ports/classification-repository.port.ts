import type { Classification, ClassificationFeedback } from "../entities.js";
import type { Category, Priority } from "../enums.js";

export interface ClassificationRepository {
  create(classification: Omit<Classification, "id" | "createdAt">): Classification;
  findByInboundItemId(inboundItemId: string): Classification | null;
  findAll(options: {
    category?: Category;
    minPriority?: Priority;
    limit?: number;
    offset?: number;
    userId?: string;
  }): Classification[];
  count(options?: { category?: Category; userId?: string }): number;
}

export interface ClassificationFeedbackRepository {
  create(feedback: Omit<ClassificationFeedback, "id" | "createdAt">): ClassificationFeedback;
  findByClassificationId(classificationId: string): ClassificationFeedback[];
}
