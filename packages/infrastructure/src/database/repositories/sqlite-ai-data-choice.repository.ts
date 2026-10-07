import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { AiDataChoice, AiDataChoiceRepository, ProviderId } from "@oneon/application";

type Row = { id: string; identity_id: string; provider: string; max_class: "D1" | "D2"; decided_on: string | null; note: string | null; confirmed_at: string };
const map = (r: Row): AiDataChoice => ({
  id: r.id,
  identityId: r.identity_id,
  provider: r.provider as ProviderId,
  maxClass: r.max_class,
  decidedOn: r.decided_on,
  note: r.note,
  confirmedAt: r.confirmed_at,
});

export class SqliteAiDataChoiceRepository implements AiDataChoiceRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly newId: () => string = randomUUID,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  current(identityId: string, provider: ProviderId): AiDataChoice | null {
    const row = this.db
      .prepare("SELECT * FROM ai_data_choices WHERE identity_id = ? AND provider = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(identityId, provider) as Row | undefined;
    return row ? map(row) : null;
  }

  record(c: Omit<AiDataChoice, "id">): AiDataChoice {
    const id = this.newId();
    this.db
      .prepare(
        "INSERT INTO ai_data_choices (id, identity_id, provider, max_class, decided_on, note, confirmed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, c.identityId, c.provider, c.maxClass, c.decidedOn, c.note, c.confirmedAt, this.clock().toISOString());
    return { ...c, id };
  }

  history(identityId: string): AiDataChoice[] {
    return (this.db.prepare("SELECT * FROM ai_data_choices WHERE identity_id = ? ORDER BY created_at, rowid").all(identityId) as Row[]).map(map);
  }
}
