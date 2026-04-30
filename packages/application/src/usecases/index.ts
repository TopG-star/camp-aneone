export {
  ingestOutlookWebhook,
  type OutlookWebhookPayload,
  type IngestOutlookWebhookResult,
  type IngestOutlookWebhookDeps,
} from "./ingest-outlook-webhook.js";

export {
  classifyItem,
  type ClassifyItemDeps,
  type ClassifyItemResult,
} from "./classify-item.js";

export {
  processUnclassifiedItems,
  type ProcessUnclassifiedItemsDeps,
  type ProcessUnclassifiedItemsSummary,
  type SkipRule,
} from "./process-unclassified-items.js";

export {
  proposeActions,
  deriveActions,
  ACTION_RISK_LEVELS,
  type ProposeActionsDeps,
  type ProposeActionsResult,
  type ProposedAction,
} from "./propose-actions.js";

export {
  executeAction,
  type ExecuteActionDeps,
  type ExecuteActionResult,
} from "./execute-action.js";

export {
  assertValidTransition,
  InvalidTransitionError,
} from "./transition-action-status.js";

export {
  sendChatMessage,
  type SendChatMessageDeps,
  type SendChatMessageInput,
  type SendChatMessageResult,
} from "./send-chat-message.js";

export {
  truncateHistory,
  type TruncateHistoryOptions,
} from "./truncate-history.js";

export {
  buildChatContext,
  type BuildChatContextInput,
  type ChatContextStats,
  type ChatPersonaProfile,
  type ToolCallRecord,
} from "./build-chat-context.js";

export {
  runIntentLoop,
  intentOutputSchema,
  type RunIntentLoopDeps,
  type RunIntentLoopInput,
  type RunIntentLoopResult,
  type StopReason,
} from "./run-intent-loop.js";

export {
  synthesizeResponse,
  buildSynthesisPrompt,
  extractJsonFromText,
  synthesisResponseSchema,
  SYNTHESIS_PROMPT_VERSION,
  type SynthesisResponse,
  type BuildSynthesisPromptInput,
  type SynthesizeResponseDeps,
  type SynthesizeResponseResult,
} from "./synthesize-response.js";

export {
  runProcessingCycle,
  type RunProcessingCycleDeps,
  type RunProcessingCycleOptions,
  type CycleSummary,
  type DailyCallCounter,
} from "./run-processing-cycle.js";

export {
  generateDailyBriefing,
  buildBriefingPrompt,
  BRIEFING_PROMPT_VERSION,
  type GenerateDailyBriefingDeps,
  type GenerateDailyBriefingInput,
  type GenerateDailyBriefingResult,
  type BriefingData,
  type UrgentItemSummary,
  type CalendarStatus,
} from "./generate-daily-briefing.js";

export {
  ingestGmail,
  type BankStatementIntakeConfig,
  type IngestGmailDeps,
  type IngestGmailResult,
} from "./ingest-gmail.js";

export {
  ingestGitHubWebhook,
  type GitHubWebhookPayload,
  type IngestGitHubWebhookResult,
  type IngestGitHubWebhookDeps,
} from "./ingest-github-webhook.js";

export {
  ingestTeamsWebhook,
  type TeamsWebhookPayload,
  type IngestTeamsWebhookResult,
  type IngestTeamsWebhookDeps,
} from "./ingest-teams-webhook.js";

export {
  checkApproachingDeadlines,
  type CheckApproachingDeadlinesDeps,
  type CheckApproachingDeadlinesOptions,
  type CheckApproachingDeadlinesResult,
} from "./check-approaching-deadlines.js";

export {
  evaluateReminderPriorityPolicy,
  type ReminderPriorityPolicyInput,
  type ReminderPriorityPolicyDecision,
  type ReminderPriorityPolicyReason,
} from "./reminder-priority-policy.js";
