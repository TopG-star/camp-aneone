import type { PushSubscription } from "../entities.js";

export interface PushSubscriptionRepository {
  upsert(
    subscription: Omit<PushSubscription, "id" | "createdAt">,
  ): PushSubscription;
  findByUserId(userId: string): PushSubscription[];
  findAll(): PushSubscription[];
  deleteByEndpoint(endpoint: string, userId?: string): void;
}
