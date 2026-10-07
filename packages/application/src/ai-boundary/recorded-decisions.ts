import type { ProviderId } from "./types.js";

/** Decisions recorded in the design session; each takes effect only once the person confirms it in Settings → AI data (spec §2.12). */
export const RECORDED_DECISIONS: Array<{ provider: ProviderId; maxClass: "D2"; decidedOn: string; note: string }> = [
  {
    provider: "deepseek",
    maxClass: "D2",
    decidedOn: "2026-10-03",
    note: "Approved by Gerry in the 2026-10-03 design session for his personal email, pending confirmation after checking DeepSeek's current terms.",
  },
];
