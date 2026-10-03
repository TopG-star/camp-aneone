import type { InboundItem } from "@oneon/domain";
import type { ModelRequest } from "../types.js";

/** Spec §10.1: exactly five fields. Free text is D2; the sender is a person entity. */
export function emailClassificationRequest(item: Pick<InboundItem, "from" | "subject" | "bodyPreview" | "receivedAt" | "source">): ModelRequest {
  return {
    purpose: "email_classification",
    output: "json",
    parts: [
      {
        kind: "record",
        source: "email",
        rows: [
          {
            fields: [
              { name: "from", class: "D2", value: item.from, entity: { type: "person", id: item.from } },
              { name: "subject", class: "D2", value: item.subject, freeText: true },
              { name: "bodyPreview", class: "D2", value: item.bodyPreview, freeText: true },
              { name: "receivedAt", class: "D1", value: item.receivedAt },
              { name: "source", class: "D0", value: item.source },
            ],
          },
        ],
      },
    ],
  };
}
