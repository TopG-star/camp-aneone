import { z } from "zod";
import type { TenantToolScope, ToolDefinition, ToolResult } from "./tool-registry.js";

/** The slice of a membership this tool reads (the control database's Membership, structurally). */
export interface AccessMembership {
  identityId: string;
  status: string;
  role: string;
  permissions: string[];
  locationIds: string[];
  snapshotAt: string;
}

export interface ShowMyAccessDeps {
  memberships: { findById(id: string): AccessMembership | null };
}

// Takes no parameters; the server-injected identity keys are stripped.
export const showMyAccessSchema = z.object({});

const NOT_CONFIRMED = "Your access to this pharmacy could not be confirmed.";

/** Tenant only: shows the signed-in person what Oneon holds about their access. No business data. */
export function createShowMyAccessTool(deps: ShowMyAccessDeps): ToolDefinition {
  return {
    name: "show_my_access",
    version: "1.0.0",
    contexts: ["tenant"],
    description: "Show the signed-in person's role, permissions and locations at this pharmacy, and when Oneon last confirmed them.",
    inputSchema: showMyAccessSchema,
    output: {
      fields: { role: { class: "D1" }, permissions: { class: "D1" }, locationIds: { class: "D1" }, snapshotAt: { class: "D1" } },
      summaryClass: "D1",
    },
    execute(_validatedInput: unknown, scope?: TenantToolScope): ToolResult {
      if (!scope) throw new Error("show_my_access needs a tenant context");
      // The membership is the request's own, named by the server's scope, and must still be this identity's and active.
      const m = deps.memberships.findById(scope.membershipId);
      if (!m || m.identityId !== scope.identityId || m.status !== "active") return { data: null, summary: NOT_CONFIRMED };
      return {
        data: { role: m.role, permissions: m.permissions, locationIds: m.locationIds, snapshotAt: m.snapshotAt },
        summary: `Role ${m.role}, ${m.permissions.length} permission${m.permissions.length === 1 ? "" : "s"}, ${m.locationIds.length} location${m.locationIds.length === 1 ? "" : "s"}.`,
      };
    },
  };
}
