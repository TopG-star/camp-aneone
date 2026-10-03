import type { BriefingData } from "../../usecases/generate-daily-briefing.js";
import type { ClassifiedField, ModelRequest, PromptPart } from "../types.js";

const rec = (source: string, rows: ClassifiedField[][]): PromptPart => ({ kind: "record", source, rows: rows.map((fields) => ({ fields })) });

/** A nullable free-text or optional field is left out when null, so a missing value is never sent as the text "null". */
const optional = (field: ClassifiedField): ClassifiedField[] => (field.value == null ? [] : [field]);

export function buildBriefingRequest(data: BriefingData): ModelRequest {
  return {
    purpose: "daily_briefing",
    output: "text",
    parts: [
      rec("briefing_meta", [[{ name: "date", class: "D1", value: data.date }, { name: "calendarStatus", class: "D1", value: data.calendar.status }]]),
      rec("urgent_items", data.urgentItems.map((i) => [
        { name: "id", class: "D1", value: i.id },
        { name: "subject", class: "D2", value: i.subject, freeText: true },
        { name: "from", class: "D2", value: i.from, entity: { type: "person", id: i.from } },
        { name: "source", class: "D1", value: i.source },
        { name: "category", class: "D1", value: i.category },
        { name: "priority", class: "D1", value: i.priority },
        { name: "summary", class: "D2", value: i.summary, freeText: true },
      ])),
      rec("deadlines", data.deadlines.map((d) => [
        { name: "dueDate", class: "D1", value: d.dueDate },
        { name: "description", class: "D2", value: d.description, freeText: true },
        { name: "status", class: "D1", value: d.status },
        { name: "confidence", class: "D1", value: d.confidence },
      ])),
      rec("calendar", data.calendar.events.map((e) => [
        { name: "start", class: "D1", value: e.start },
        { name: "end", class: "D1", value: e.end },
        { name: "allDay", class: "D1", value: e.allDay },
        { name: "title", class: "D2", value: e.title, freeText: true },
        ...optional({ name: "location", class: "D2", value: e.location }),
        { name: "attendees", class: "D2", value: e.attendees },
        ...optional({ name: "description", class: "D2", value: e.description, freeText: true }),
      ])),
      rec("pending_actions", data.pendingActions.map((a) => [
        { name: "actionType", class: "D1", value: a.actionType },
        { name: "resourceId", class: "D1", value: a.resourceId },
        { name: "riskLevel", class: "D1", value: a.riskLevel },
      ])),
    ],
  };
}
