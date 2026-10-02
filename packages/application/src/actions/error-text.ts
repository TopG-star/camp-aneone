import type { ActionError } from "@oneon/domain";

/**
 * Plain text for an action's error (spec §10.6, §13.1). The stored message can hold raw codes
 * or Google response bodies; those stay in the database and logs and are never shown.
 */
const TEXT: Record<string, string> = {
  // Validation and the pre-execution re-check
  deadline_exists: "The deadline this reminder was for no longer exists, so Oneon didn't add it.",
  deadline_missing: "The deadline this reminder was for no longer exists, so Oneon didn't add it.",
  deadline_open: "The deadline is already done or dismissed, so Oneon didn't add the reminder.",
  due_date_not_passed: "The due date has already passed, so Oneon didn't add the reminder.",
  not_suppressed: "This kind of notification is turned off or it's quiet hours, so Oneon didn't send it.",
  calendar_connected: "Google Calendar isn't connected. Connect Google in Settings, then try again.",
  calendar_not_connected: "Google Calendar isn't connected. Connect Google in Settings, then try again.",
  event_exists: "The calendar event no longer exists, so nothing was changed.",
  event_not_found: "The calendar event no longer exists, so nothing was changed.",
  invalid_time_range: "The change would put the event's end before its start, so nothing was changed.",
  changed_since_approval:
    "What this action would do changed after it was approved, so Oneon didn't run it. Try again to review the new version.",
  approval_required_now: "This action now needs approval, so Oneon didn't run it. Try again to send it for approval.",
  policy_refused_now: "Your settings no longer allow this action, so Oneon didn't run it.",
  // Execution: definite failures (nothing changed)
  missing_version: "Google didn't report the event's version, so Oneon didn't change it.",
  changed_since: "Someone changed the event after Oneon checked it, so Oneon didn't change it.",
  not_found: "The calendar event no longer exists, so nothing was changed.",
  rejected_by_google: "Google Calendar refused the change, so nothing was changed.",
  auth: "Oneon couldn't sign in to Google, so nothing was changed. Reconnect Google in Settings, then try again.",
  notifications_unavailable: "Notifications aren't set up, so Oneon couldn't send this.",
  // Execution: unknown outcomes (the action is being verified)
  timeout: "Google didn't confirm the change in time. Oneon is checking whether it went through.",
  google_unavailable: "Google didn't confirm the change. Oneon is checking whether it went through.",
  google_unreachable: "Oneon couldn't reach Google to confirm the change. Oneon is checking whether it went through.",
  already_exists: "Google says this event may already exist. Oneon is checking whether it went through.",
  unexpected_error: "Something went wrong while sending the change. Oneon is checking whether it went through.",
  // Verification
  effect_absent: "Oneon checked and the change isn't there, so nothing was changed.",
  effect_absent_after_success:
    "Google accepted the change, but it no longer matches what Oneon wrote. Someone may have edited or deleted it since.",
  checks_failed: "The change was made, but some details don't match what was asked. See Checks.",
  no_verification: "Oneon can't check whether this action worked.",
};

const STAGE_FALLBACK: Record<ActionError["stage"], string> = {
  validation: "Oneon couldn't run this action.",
  recheck: "Oneon couldn't run this action.",
  execution: "Oneon couldn't complete this action.",
  verification: "Oneon couldn't confirm this action.",
  undo: "Oneon couldn't undo this.",
};

/** What the owner must do by hand when an undo did not finish (spec §10.6). */
function manualFix(actionType: string): string {
  if (actionType === "update_calendar_event") return "Change it back in Google Calendar if you still want the old details.";
  if (actionType === "create_calendar_event" || actionType === "create_reminder") {
    return "Delete it in Google Calendar if you still want it gone.";
  }
  return "Check the result and reverse it by hand if you still want it undone.";
}

function checkFix(actionType: string): string {
  if (actionType === "update_calendar_event") return "Check Google Calendar and change the event back if it still shows the new details.";
  if (actionType === "create_calendar_event" || actionType === "create_reminder") {
    return "Check Google Calendar and delete the event if it's still there.";
  }
  return "Check the result and reverse it by hand if you still want it undone.";
}

function undoText(code: string, actionType: string): string {
  const verb = actionType === "update_calendar_event" ? "updated" : "created";
  switch (code) {
    case "changed_since":
      return `Someone changed this event after Oneon ${verb} it, so Oneon left it alone. ${manualFix(actionType)}`;
    case "not_found":
      return "The event no longer exists in Google Calendar, so there was nothing left for Oneon to undo.";
    case "interrupted":
      return `The undo was interrupted and Oneon couldn't confirm it. ${checkFix(actionType)}`;
    case "undo_unverified":
      return `Oneon asked Google to undo this but couldn't confirm it worked. ${checkFix(actionType)}`;
    case "nothing_to_undo":
      return `Oneon didn't record how to undo this. ${manualFix(actionType)}`;
    case "auth":
      return `Oneon couldn't sign in to Google to undo this. ${manualFix(actionType)}`;
    case "calendar_not_connected":
      return `Google Calendar isn't connected, so Oneon couldn't undo this. ${manualFix(actionType)}`;
    case "rejected_by_google":
      return `Google Calendar refused the undo. ${manualFix(actionType)}`;
    default:
      return `${STAGE_FALLBACK.undo} ${manualFix(actionType)}`;
  }
}

export function describeActionError(error: ActionError, actionType: string): string {
  if (error.stage === "undo") return undoText(error.code, actionType);
  return TEXT[error.code] ?? STAGE_FALLBACK[error.stage] ?? STAGE_FALLBACK.execution;
}
