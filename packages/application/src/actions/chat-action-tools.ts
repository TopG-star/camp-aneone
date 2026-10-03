import { z } from "zod";
import { personalActor, type ActionInstance, type LifecycleStatus } from "@oneon/domain";
import type { ToolDefinition, ToolResult } from "../tools/tool-registry.js";
import type { ActionRegistry } from "./registry.js";
import { describeReason, type PolicyDecision } from "./policy/index.js";
import { describeInstance } from "./orchestrator/shared.js";
import { describeActionError } from "./error-text.js";
import type { ActionRequest, RequestOutcome } from "./orchestrator/types.js";

export interface ChatActionRef {
  id: string;
  actionType: string;
  label: string;
  status: LifecycleStatus;
}

export interface ChatActionToolDeps {
  requestAction(req: ActionRequest): Promise<RequestOutcome>;
  registry: ActionRegistry;
  aiModel: string;
  clock(): Date;
}

// Server-injected by run-intent-loop after the AI's parameters, so the AI cannot set them.
const serverFields = z
  .object({
    userId: z.string().min(1).optional(),
    turnId: z.string().min(1).optional(),
    turnExcerpt: z.string().optional(),
  })
  .passthrough();

function statusSummary(deps: ChatActionToolDeps, instance: ActionInstance): string {
  const def = deps.registry.get(instance.actionType);
  const what = describeInstance(def, instance);
  switch (instance.status) {
    case "completed":
      return `Completed: ${what}`;
    case "awaiting_approval":
      return `Waiting for your approval in Action Center. Do not describe this action as done. Planned: ${what}`;
    case "verifying":
      return "Sent to Google; couldn't confirm yet. Oneon will check again automatically; see Action Center.";
    case "rejected": {
      const decision = instance.decision as unknown as PolicyDecision | null;
      const reason = decision?.reasons[0] ? describeReason(decision.reasons[0], def) : "rejected";
      return `Not done (rejected): ${reason}`;
    }
    case "failed":
    case "cancelled":
      return `Not done (${instance.status}): ${instance.error ? describeActionError(instance.error, instance.actionType) : instance.status}`;
    default:
      return `In progress (${instance.status}); see Action Center.`;
  }
}

function makeTool(deps: ChatActionToolDeps, type: string, description: string): ToolDefinition {
  return {
    name: type,
    version: "2.0.0",
    description,
    inputSchema: serverFields,
    output: {
      fields: { action: { class: "D1" }, refused: { class: "D1" }, issues: { class: "D2", freeText: true } },
      summaryClass: "D2",
    },
    async execute(validatedInput: unknown): Promise<ToolResult> {
      const { userId, turnId, turnExcerpt, ...actionInput } = validatedInput as z.infer<typeof serverFields>;
      if (!userId || !turnId) return { data: null, summary: "This tool needs a signed-in chat session." };

      const outcome = await deps.requestAction({
        type,
        input: actionInput,
        actor: personalActor(userId),
        initiator: "user",
        keyContext: { source: "chat", turnId },
        evidence: [
          {
            kind: "chat_turn",
            source: "chat",
            asOf: deps.clock().toISOString(),
            data: { turnId, excerpt: turnExcerpt ?? null, model: deps.aiModel },
          },
        ],
        resourceRef: null,
      });

      if (outcome.kind === "refused") {
        return {
          data: { refused: outcome.reason, issues: outcome.issues },
          summary:
            outcome.reason === "invalid_input"
              ? `Not created. Fix these inputs and try again: ${outcome.issues.join("; ")}`
              : `Not created: ${outcome.issues.join("; ")}`,
        };
      }

      const def = deps.registry.get(outcome.instance.actionType);
      const action: ChatActionRef = { id: outcome.instance.id, actionType: def.type, label: def.label, status: outcome.instance.status };
      const summary = statusSummary(deps, outcome.instance);
      return {
        data: { action },
        summary: outcome.kind === "duplicate" ? `Already requested in this turn: ${outcome.instance.status}. ${summary}` : summary,
      };
    },
  };
}

/** Chat's calendar tools: they request actions instead of writing (spec §10.3). */
export function createChatActionTools(deps: ChatActionToolDeps): ToolDefinition[] {
  return [
    makeTool(
      deps,
      "create_calendar_event",
      "Request a Google Calendar event: title, start and end as ISO-8601 with a UTC offset, optional description, attendees (emails) and location. Inviting other people needs the user's approval; report the returned status truthfully.",
    ),
    makeTool(
      deps,
      "update_calendar_event",
      "Request a change to an existing Google Calendar event: eventId plus any of title, start, end (ISO-8601 with offset), description, attendees, location. Changes involving other people need approval; report the returned status truthfully.",
    ),
  ];
}
