import type { ProviderId } from "./types.js";

/**
 * A model call the gateway has decided on and assembled. Provider clients accept nothing else
 * (spec §5.5). Only `gateway.ts` may call `mint`: an architecture test enforces it.
 */
export class ApprovedModelCall {
  readonly callId!: string;
  readonly provider!: ProviderId;
  readonly model!: string;
  readonly system!: string;
  readonly user!: string;
  readonly json!: boolean;
  readonly maxTokens!: number;
  readonly timeoutMs!: number;

  private constructor() {}

  static mint(fields: {
    callId: string;
    provider: ProviderId;
    model: string;
    system: string;
    user: string;
    json: boolean;
    maxTokens: number;
    timeoutMs: number;
  }): ApprovedModelCall {
    return Object.freeze(Object.assign(new ApprovedModelCall(), fields));
  }
}

export interface ProviderCompletion {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface ModelProvider {
  readonly id: ProviderId;
  complete(call: ApprovedModelCall): Promise<ProviderCompletion>;
}

/** A provider failure. `retryable` is true for transient faults (empty response, timeout). */
export class ProviderError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "ProviderError";
  }
}
