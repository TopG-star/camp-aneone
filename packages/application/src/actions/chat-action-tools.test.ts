import { describe, it, expect, vi } from "vitest";
import { personalActor, type ActionInstance } from "@oneon/domain";
import { createChatActionTools } from "./chat-action-tools.js";
import { createActionRegistry } from "./registry.js";
import { createActionDefinitions } from "./definitions/index.js";
import type { RequestOutcome } from "./orchestrator/types.js";
import { expectMatchesOutputSchema } from "../tools/__tests__/output-contract.js";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const registry = createActionRegistry(createActionDefinitions());
const instance = (over: Partial<ActionInstance>) =>
  ({ id: "a1", actionType: "create_calendar_event", status: "completed", input: {}, resolved: null, error: null, decision: null, ...over }) as ActionInstance;

function tools(outcome: RequestOutcome) {
  const requestAction = vi.fn().mockResolvedValue(outcome);
  const [create, update] = createChatActionTools({ requestAction, registry, aiModel: "claude-test", clock: () => NOW });
  return { create, update, requestAction };
}

const args = { title: "Call", start: "2026-10-07T10:00:00+00:00", end: "2026-10-07T10:30:00+00:00", userId: "u1", turnId: "msg-1", turnExcerpt: "set up a call" };

describe("chat action tools", () => {
  it("requests the action with server-supplied identity and chat evidence", async () => {
    const { create, requestAction } = tools({ kind: "created", instance: instance({}) });
    await create.execute(create.inputSchema.parse(args));
    expect(requestAction).toHaveBeenCalledWith({
      type: "create_calendar_event",
      input: { title: "Call", start: "2026-10-07T10:00:00+00:00", end: "2026-10-07T10:30:00+00:00" },
      actor: expect.objectContaining({ userId: "u1", scope: "personal" }),
      initiator: "user",
      keyContext: { source: "chat", turnId: "msg-1" },
      evidence: [{ kind: "chat_turn", source: "chat", asOf: "2026-10-01T12:00:00.000Z", data: { turnId: "msg-1", excerpt: "set up a call", model: "claude-test" } }],
      resourceRef: null,
    });
  });

  it("acts as the server-supplied user and leaves tenant keys in the input for the strict schema to refuse", async () => {
    const { create, requestAction } = tools({ kind: "created", instance: instance({}) });
    await create.execute(create.inputSchema.parse({ ...args, ownerId: "someone-else" }));
    const req = requestAction.mock.calls[0][0];
    expect(req.actor).toEqual(personalActor("u1"));
    // The tool never strips or honours ownerId; the action's strict input schema rejects it.
    expect(req.input).toMatchObject({ ownerId: "someone-else" });
    expect(registry.get("create_calendar_event").inputSchema.safeParse(req.input).success).toBe(false);
  });

  it("exposes update_calendar_event and requests that type", async () => {
    const { update, requestAction } = tools({ kind: "created", instance: instance({ actionType: "update_calendar_event" }) });
    expect(update.name).toBe("update_calendar_event");
    await update.execute(update.inputSchema.parse({ eventId: "ev1", title: "New", userId: "u1", turnId: "msg-1" }));
    expect(requestAction).toHaveBeenCalledWith(
      expect.objectContaining({ type: "update_calendar_event", input: { eventId: "ev1", title: "New" }, keyContext: { source: "chat", turnId: "msg-1" } }),
    );
  });

  it.each([
    [instance({ status: "awaiting_approval" }), /^Waiting for your approval in Action Center\. Do not describe this action as done\./],
    [instance({ status: "completed" }), /^Completed: /],
    [instance({ status: "verifying" }), /^Sent to Google; couldn't confirm yet\./],
    [instance({ status: "failed", error: { code: "calendar_connected", message: "Precondition not met: calendar_connected", stage: "validation" } }), /^Not done \(failed\): Google Calendar isn't connected\./],
    [instance({ status: "failed", error: { code: "rejected_by_google", message: 'Google Calendar API error 400: {"error":{}}', stage: "execution" } }), /^Not done \(failed\): Google Calendar refused the change, so nothing was changed\.$/],
  ])("tells the AI the truth for %#", async (inst, pattern) => {
    const { create } = tools({ kind: "created", instance: inst });
    const result = await create.execute(create.inputSchema.parse(args));
    expect(result.summary).toMatch(pattern);
    expect(result.data).toMatchObject({ action: { id: "a1", actionType: "create_calendar_event", label: "Create calendar event", status: inst.status } });
    expectMatchesOutputSchema(create, result);
  });

  it("reports duplicates and refusals", async () => {
    const dup = tools({ kind: "duplicate", instance: instance({ status: "awaiting_approval" }) });
    expect((await dup.create.execute(dup.create.inputSchema.parse(args))).summary).toMatch(/^Already requested in this turn: awaiting_approval\./);
    const bad = tools({ kind: "refused", reason: "invalid_input", issues: ["start: Use an ISO-8601 date-time with a UTC offset"] });
    expect((await bad.create.execute(bad.create.inputSchema.parse(args))).summary).toBe(
      "Not created. Fix these inputs and try again: start: Use an ISO-8601 date-time with a UTC offset",
    );
  });

  it("a real refusal matches the output schema", async () => {
    const { create } = tools({ kind: "refused", reason: "invalid_input", issues: ["start: bad"] });
    const result = await create.execute(create.inputSchema.parse(args));
    expectMatchesOutputSchema(create, result);
  });

  it("refuses without a signed-in session", async () => {
    const { create, requestAction } = tools({ kind: "created", instance: instance({}) });
    const result = await create.execute(create.inputSchema.parse({ title: "x" }));
    expect(result.summary).toBe("This tool needs a signed-in chat session.");
    expect(requestAction).not.toHaveBeenCalled();
  });
});
