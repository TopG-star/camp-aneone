import type { ConversationMessage } from "@oneon/domain";

export interface TruncateHistoryOptions {
  maxMessages: number;
  maxCharsPerMessage: number;
  totalBudget: number;
}

export function truncateHistory(
  messages: ConversationMessage[],
  options: TruncateHistoryOptions
): ConversationMessage[] {
  const { maxMessages, maxCharsPerMessage, totalBudget } = options;

  if (messages.length === 0) return [];

  // Step 1: Keep only the most recent maxMessages
  let result = messages.slice(-maxMessages);

  // Step 2: Truncate each message's content to maxCharsPerMessage (immutable)
  result = result.map((msg) =>
    msg.content.length > maxCharsPerMessage
      ? { ...msg, content: msg.content.slice(0, maxCharsPerMessage) }
      : msg
  );

  // Step 3: Enforce total budget by dropping oldest messages
  let totalChars = result.reduce((sum, msg) => sum + msg.content.length, 0);

  while (result.length > 1 && totalChars > totalBudget) {
    totalChars -= result[0].content.length;
    result = result.slice(1);
  }

  // Step 4: If the single remaining message still exceeds budget, truncate it
  if (result.length === 1 && result[0].content.length > totalBudget) {
    result = [{ ...result[0], content: result[0].content.slice(0, totalBudget) }];
  }

  return result;
}
