import { NotificationEventType, type ActionInstance, type Logger, type NotificationPort } from "@oneon/domain";
import type { ActionNotifier } from "./orchestrator/types.js";

export function createActionNotifier(port: Pick<NotificationPort, "send">, logger: Logger): ActionNotifier {
  return {
    async awaitingApproval(instance: ActionInstance, description: string) {
      await port.send({
        eventType: NotificationEventType.ActionProposed,
        title: "Action needs your approval",
        body: description,
        deepLink: `/actions#action-${instance.id}`,
        userId: instance.userId,
      });
      logger.debug("Approval notification sent", { actionId: instance.id });
    },
    async rollbackFailed(instance: ActionInstance, description: string) {
      await port.send({
        eventType: NotificationEventType.ActionRollbackFailed,
        title: "Undo failed — needs a manual fix",
        body: description,
        deepLink: `/actions#action-${instance.id}`,
        userId: instance.userId,
      });
    },
  };
}
