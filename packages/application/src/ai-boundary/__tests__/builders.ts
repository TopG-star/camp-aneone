import { instruction } from "../instruction.js";
import { PROVIDER_REGISTRY } from "../providers.js";
import type { ClassifiedField, ClassifiedRow, DataClass, ModelContext, ModelRequest, PromptPart } from "../types.js";
import type { DecideInput } from "../decide.js";

export const personal = { kind: "personal", identityId: "u1" } satisfies ModelContext;
export const tenant = { kind: "tenant", identityId: "u1", tenantId: "t1", membershipId: "m1" } satisfies ModelContext;

export const field = (name: string, cls: DataClass | null, value: unknown, extra: Partial<ClassifiedField> = {}): ClassifiedField => ({
  name,
  class: cls,
  value,
  ...extra,
});
export const row = (fields: ClassifiedField[], rowClass?: DataClass): ClassifiedRow => ({ fields, ...(rowClass ? { rowClass } : {}) });
export const record = (source: string, rows: ClassifiedRow[]): PromptPart => ({ kind: "record", source, rows });
export const userMessage = (text: string): PromptPart => ({ kind: "user_message", text });
export const sys = (): PromptPart => ({ kind: "instruction", text: instruction`extra rule` });

export const emailRecord = (overrides: Partial<Record<string, unknown>> = {}) =>
  record("email", [
    row([
      field("from", "D2", overrides.from ?? "ama@example.com", { entity: { type: "person", id: String(overrides.from ?? "ama@example.com") } }),
      field("subject", "D2", overrides.subject ?? "Invoice", { freeText: true }),
      field("bodyPreview", "D2", overrides.bodyPreview ?? "Please pay by Friday.", { freeText: true }),
      field("receivedAt", "D1", "2026-10-03T09:00:00Z"),
      field("source", "D0", "gmail"),
    ]),
  ]);

export function input(overrides: Partial<Omit<DecideInput, "request">> & { request?: Partial<ModelRequest> } = {}): DecideInput {
  const { request, ...rest } = overrides;
  return {
    context: personal,
    provider: { entry: PROVIDER_REGISTRY.deepseek },
    choiceLimit: "D2",
    ...rest,
    request: { purpose: "email_classification", output: "json", parts: [emailRecord()], ...request },
  };
}
