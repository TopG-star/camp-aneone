import { z } from "zod";
import type { AnyActionDefinition } from "../definition.js";
import { unavailableDefinition } from "./unavailable.js";

const MODIFY = "needs Gmail modify access (gmail.modify)";
const COMPOSE = "needs Gmail compose access (gmail.compose)";
const SEND = "needs Gmail send access (gmail.send)";
const item = z.string().min(1);

export const GMAIL_DEFINITIONS: AnyActionDefinition[] = [
  unavailableDefinition({
    type: "archive", label: "Archive email", description: "Archive this email in Gmail.",
    reason: MODIFY, riskFloor: "L1", approvalFloor: "auto", rollbackClass: "reversible",
    inputSchema: z.object({ inboundItemId: item, reason: z.string() }).strict(),
    describe: () => "Archive this email in Gmail.",
  }),
  unavailableDefinition({
    type: "label", label: "Label email", description: "Apply a Gmail label to this email.",
    reason: MODIFY, riskFloor: "L1", approvalFloor: "auto", rollbackClass: "reversible",
    inputSchema: z.object({ inboundItemId: item, label: z.string().min(1), reason: z.string() }).strict(),
    describe: (input) => `Label this email "${input.label}" in Gmail.`,
  }),
  unavailableDefinition({
    type: "draft_reply", label: "Draft reply", description: "Create a Gmail draft replying to this email.",
    reason: COMPOSE, riskFloor: "L1", approvalFloor: "auto", rollbackClass: "reversible",
    inputSchema: z.object({ inboundItemId: item, reason: z.string(), summary: z.string(), from: z.string() }).strict(),
    describe: (input) => `Draft a reply to ${input.from} in Gmail.`,
  }),
  unavailableDefinition({
    type: "delete", label: "Delete email", description: "Delete this email in Gmail.",
    reason: MODIFY, riskFloor: "L3", approvalFloor: "always", rollbackClass: "irreversible",
    inputSchema: z.object({ inboundItemId: item, reason: z.string() }).strict(),
    describe: () => "Delete this email in Gmail.",
  }),
  unavailableDefinition({
    type: "send", label: "Send email", description: "Send an email reply from Gmail.",
    reason: SEND, riskFloor: "L3", approvalFloor: "always", rollbackClass: "irreversible",
    inputSchema: z
      .object({ inboundItemId: item, to: z.array(z.string().email()).min(1), subject: z.string().min(1), body: z.string().min(1) })
      .strict(),
    describe: (input) => `Send "${input.subject}" to ${input.to.join(", ")}.`,
  }),
  unavailableDefinition({
    type: "forward", label: "Forward email", description: "Forward this email from Gmail.",
    reason: SEND, riskFloor: "L3", approvalFloor: "always", rollbackClass: "irreversible",
    inputSchema: z.object({ inboundItemId: item, to: z.array(z.string().email()).min(1), note: z.string().optional() }).strict(),
    describe: (input) => `Forward this email to ${input.to.join(", ")}.`,
  }),
];
