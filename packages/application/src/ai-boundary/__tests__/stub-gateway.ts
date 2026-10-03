import type { DenyReason } from "../decide.js";
import type { OutputBlockReason } from "../answer-check.js";
import type { GatewayResult, ModelGateway } from "../gateway.js";
import type { DataClass, ModelRequest } from "../types.js";

export const answered = (json: unknown, text = JSON.stringify(json)): GatewayResult => ({ kind: "answered", text, json, withheld: [], decisionId: "d" });
export const denied = (reason: DenyReason): GatewayResult => ({ kind: "denied", reason, withheld: [], decisionId: "d" });
export const blocked = (reason: OutputBlockReason): GatewayResult => ({ kind: "blocked", reason, withheld: [], decisionId: "d" });

export function stubGateway(opts: { limit?: DataClass | null; respond?: (req: ModelRequest) => GatewayResult } = {}) {
  const requests: ModelRequest[] = [];
  const gateway: ModelGateway & { requests: ModelRequest[] } = {
    requests,
    beginTurn: () => ({
      async call(req) {
        requests.push(req);
        return opts.respond ? opts.respond(req) : denied("required_part_withheld");
      },
      restoreToolParams: (params) => ({ ok: true, params }),
      effectiveLimit: () => (opts.limit === undefined ? "D2" : opts.limit),
    }),
  };
  return gateway;
}
