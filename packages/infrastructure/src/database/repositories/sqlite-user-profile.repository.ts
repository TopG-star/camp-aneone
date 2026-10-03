import type Database from "better-sqlite3";
import type {
  CommunicationStyle,
  SalutationMode,
  UserProfile,
  UserProfileRepository,
  UserProfileUpsertInput,
} from "@oneon/domain";

const DEFAULT_SALUTATION_MODE: SalutationMode = "sir_with_name";
const DEFAULT_COMMUNICATION_STYLE: CommunicationStyle = "friendly";
const DEFAULT_TIMEZONE = "UTC";

export class SqliteUserProfileRepository implements UserProfileRepository {
  constructor(private readonly db: Database.Database) {}

  findByUserId(userId: string): UserProfile | null {
    const row = this.db
      .prepare(
        `SELECT
           user_id,
           preferred_name,
           nickname,
           salutation_mode,
           communication_style,
           timezone,
           created_at,
           updated_at
         FROM user_profiles
         WHERE user_id = ?`
      )
      .get(userId) as RawUserProfile | undefined;

    return row ? mapRow(row) : null;
  }

  upsert(profile: UserProfileUpsertInput): UserProfile {
    const salutationMode =
      profile.salutationMode ?? DEFAULT_SALUTATION_MODE;
    const communicationStyle =
      profile.communicationStyle ?? DEFAULT_COMMUNICATION_STYLE;
    const timezone = profile.timezone ?? DEFAULT_TIMEZONE;

    this.db
      .prepare(
        `INSERT INTO user_profiles (
           user_id,
           preferred_name,
           nickname,
           salutation_mode,
           communication_style,
           timezone,
           created_at,
           updated_at
         )
         VALUES (
           ?, ?, ?, ?, ?, ?,
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         )
         ON CONFLICT (user_id) DO UPDATE SET
           preferred_name = excluded.preferred_name,
           nickname = excluded.nickname,
           salutation_mode = excluded.salutation_mode,
           communication_style = excluded.communication_style,
           timezone = excluded.timezone,
           updated_at = excluded.updated_at`
      )
      .run(
        profile.userId,
        profile.preferredName,
        profile.nickname,
        salutationMode,
        communicationStyle,
        timezone,
      );

    return this.findByUserId(profile.userId)!;
  }

  deleteByUserId(userId: string): void {
    this.db.prepare("DELETE FROM user_profiles WHERE user_id = ?").run(userId);
  }
}

interface RawUserProfile {
  user_id: string;
  preferred_name: string | null;
  nickname: string | null;
  salutation_mode: SalutationMode;
  communication_style: CommunicationStyle;
  timezone: string;
  created_at: string;
  updated_at: string;
}

function mapRow(row: RawUserProfile): UserProfile {
  return {
    userId: row.user_id,
    preferredName: row.preferred_name,
    nickname: row.nickname,
    salutationMode: row.salutation_mode,
    communicationStyle: row.communication_style,
    timezone: row.timezone,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}