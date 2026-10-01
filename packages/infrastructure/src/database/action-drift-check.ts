import type Database from "better-sqlite3";
import type { Logger } from "@oneon/domain";

interface DriftRow {
  id: string;
  status: string;
  last_event_seq: number;
  event_status: string;
  event_seq: number;
}

/** Spec §8.4: events are authoritative; a projection that disagrees is rebuilt from them. */
export function runActionDriftCheck(db: Database.Database, logger: Logger): number {
  const drifted = db
    .prepare(
      `SELECT i.id, i.status, i.last_event_seq, e.to_status AS event_status, e.seq AS event_seq
       FROM action_instances i
       JOIN action_events e ON e.action_id = i.id
         AND e.seq = (SELECT MAX(seq) FROM action_events WHERE action_id = i.id)
       WHERE i.status <> e.to_status OR i.last_event_seq <> e.seq`,
    )
    .all() as DriftRow[];

  const repair = db.prepare("UPDATE action_instances SET status = ?, last_event_seq = ? WHERE id = ?");
  for (const row of drifted) {
    logger.error("Action projection drifted from its event log; rebuilding from events", {
      actionId: row.id,
      projectedStatus: row.status,
      eventStatus: row.event_status,
      projectedSeq: row.last_event_seq,
      eventSeq: row.event_seq,
    });
    repair.run(row.event_status, row.event_seq, row.id);
  }
  return drifted.length;
}
