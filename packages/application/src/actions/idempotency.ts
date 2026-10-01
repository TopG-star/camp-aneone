import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export const emailKey = (inboundItemId: string): string => `email:${inboundItemId}`;
export const deadlineKey = (deadlineId: string): string => `deadline:${deadlineId}`;

export function chatKey(turnId: string, input: unknown): string {
  return `chat:${turnId}:${createHash("sha256").update(canonicalJson(input)).digest("hex")}`;
}

export function retryKey(originalKey: string, retryNumber: number): string {
  return `${originalKey.replace(/:retry:\d+$/, "")}:retry:${retryNumber}`;
}
