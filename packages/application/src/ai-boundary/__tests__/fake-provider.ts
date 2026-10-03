import { ProviderError, type ApprovedModelCall, type ModelProvider, type ProviderCompletion } from "../approved-call.js";
import type { ProviderId } from "../types.js";

/** Records every approved call it receives and answers from a queue (or a function). */
export class FakeProvider implements ModelProvider {
  readonly calls: ApprovedModelCall[] = [];
  constructor(
    readonly id: ProviderId,
    private readonly answers: Array<string | Error | ((call: ApprovedModelCall) => string)> = [],
  ) {}
  async complete(call: ApprovedModelCall): Promise<ProviderCompletion> {
    this.calls.push(call);
    const next = this.answers.length > 1 ? this.answers.shift()! : this.answers[0] ?? "{}";
    if (next instanceof Error) throw next;
    return { text: typeof next === "function" ? next(call) : next };
  }
}
export const providerDown = () => new ProviderError("provider down", false);
