import { vi } from "vitest";
import { z } from "zod";
import { personalActor, type ActionCapabilities, type Logger } from "@oneon/domain";
import { createActionRegistry } from "../registry.js";
import { createActionOrchestrator } from "../orchestrator/index.js";
import type { ActionDefinition, AnyActionDefinition } from "../definition.js";
import type { ActionRequest } from "../orchestrator/types.js";
import { InMemoryActionRepo, InMemoryConfigRepo } from "./in-memory-repos.js";
import { fakeReaders, fakeWriters } from "./fakes.js";

export const silentLogger: Logger = { info() {}, warn() {}, error() {}, debug() {} };

const FLOOR = {
  risk: "L1" as const,
  approval: { mode: "auto" as const, thresholds: {} },
  requiredPermissions: [],
  approverRoles: ["owner"],
  expiryHours: 24,
};

/** A controllable definition; override any member per test. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function probeDefinition(overrides: Partial<ActionDefinition<any, any>> = {}): AnyActionDefinition {
  return {
    type: "probe",
    version: "1",
    scope: "personal",
    label: "Probe",
    description: "Test action",
    inputSchema: z.object({ n: z.number() }).strict(),
    effects: { reads: [], writes: [] },
    floor: FLOOR,
    defaults: { ...FLOOR, enabled: true },
    thresholdMetrics: {},
    rollbackClass: "reversible",
    recoveryThresholdMs: 60_000,
    executionTimeoutMs: 1_000,
    disableWarning: null,
    unavailableReason: null,
    consequenceKeys: ["metrics"],
    idempotencyKey: (input: { n: number }, ctx) => (ctx.source === "chat" ? `chat:${ctx.turnId}:${input.n}` : `rule:${ctx.resourceId}`),
    preconditions: async () => [],
    resolve: async () => ({ ok: true, resolved: { metrics: {} } }),
    riskFor: (_r, floor) => floor,
    describe: (_r, input: { n: number }) => `Probe ${input.n}`,
    execute: async () => ({ kind: "succeeded", result: { done: true }, undoData: { token: "t" } }),
    postconditions: async () => ({ effectCheckId: "effect", checks: [{ id: "effect", passed: true }] }),
    undo: {
      preconditions: async () => [{ id: "unchanged_since", failureCode: "changed_since", passed: true }],
      execute: async () => ({ kind: "succeeded", result: {}, undoData: null }),
      verify: async () => [{ id: "undone", passed: true }],
      warning: () => null,
    },
    ...overrides,
  };
}

export function harness(
  definitions: AnyActionDefinition[] = [probeDefinition()],
  options: { capabilities?: () => ActionCapabilities } = {},
) {
  let now = new Date("2026-10-01T12:00:00.000Z");
  const clock = () => now;
  const repo = new InMemoryActionRepo(clock);
  const configRepo = new InMemoryConfigRepo(clock);
  const notifier = {
    awaitingApproval: vi.fn().mockResolvedValue(undefined),
    rollbackFailed: vi.fn().mockResolvedValue(undefined),
  };
  let ids = 0;
  const orchestrator = createActionOrchestrator({
    registry: createActionRegistry(definitions),
    repo,
    configRepo,
    capabilities: options.capabilities ?? (() => ({ readers: fakeReaders(), writers: fakeWriters() })),
    notifier,
    logger: silentLogger,
    clock,
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
  });
  return {
    orchestrator,
    repo,
    configRepo,
    notifier,
    advanceClock: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

export function request(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    type: "probe",
    input: { n: 1 },
    actor: personalActor("u1"),
    initiator: "rule:test",
    keyContext: { source: "rule", resourceId: "r1" },
    evidence: [],
    resourceRef: null,
    ...overrides,
  };
}
