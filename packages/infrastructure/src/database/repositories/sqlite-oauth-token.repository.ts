import type Database from "better-sqlite3";
import type { OAuthToken, OAuthProvider, OAuthTokenRepository } from "@oneon/domain";
import type { TokenCipher } from "../../crypto/token-cipher.js";

export class SqliteOAuthTokenRepository implements OAuthTokenRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly cipher: TokenCipher,
  ) {}

  get(provider: string, userId: string): OAuthToken | null {
    const row = this.db
      .prepare(
        `SELECT provider, user_id, access_token, access_token_iv, access_token_tag,
                refresh_token, refresh_token_iv, refresh_token_tag,
                token_type, scope, expires_at, provider_email,
                created_at, updated_at
         FROM oauth_tokens
         WHERE provider = ? AND user_id = ?`,
      )
      .get(provider, userId) as RawOAuthToken | undefined;

    if (!row) return null;

    try {
      return this.mapRow(row);
    } catch {
      // Decrypt failure — key was rotated or data corrupted.
      // Caller sees "not connected" and user can re-authorize.
      console.warn(
        `[oauth-token-repo] Failed to decrypt token for provider=${provider} userId=${userId} — token unreadable after key rotation or corruption`,
      );
      return null;
    }
  }

  upsert(token: OAuthToken): void {
    const accessEnc = this.cipher.encrypt(token.accessToken);

    let refreshCiphertext: string | null = null;
    let refreshIv: string | null = null;
    let refreshTag: string | null = null;

    if (token.refreshToken !== null) {
      const refreshEnc = this.cipher.encrypt(token.refreshToken);
      refreshCiphertext = refreshEnc.ciphertext;
      refreshIv = refreshEnc.iv;
      refreshTag = refreshEnc.tag;
    }

    this.db
      .prepare(
        `INSERT INTO oauth_tokens (
           provider, user_id,
           access_token, access_token_iv, access_token_tag,
           refresh_token, refresh_token_iv, refresh_token_tag,
           token_type, scope, expires_at, provider_email,
           created_at, updated_at
         ) VALUES (
           ?, ?,
           ?, ?, ?,
           ?, ?, ?,
           ?, ?, ?, ?,
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         )
         ON CONFLICT (provider, user_id) DO UPDATE SET
           access_token     = excluded.access_token,
           access_token_iv  = excluded.access_token_iv,
           access_token_tag = excluded.access_token_tag,
           refresh_token     = excluded.refresh_token,
           refresh_token_iv  = excluded.refresh_token_iv,
           refresh_token_tag = excluded.refresh_token_tag,
           token_type       = excluded.token_type,
           scope            = excluded.scope,
           expires_at       = excluded.expires_at,
           provider_email   = excluded.provider_email,
           updated_at       = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      )
      .run(
        token.provider,
        token.userId,
        accessEnc.ciphertext,
        accessEnc.iv,
        accessEnc.tag,
        refreshCiphertext,
        refreshIv,
        refreshTag,
        token.tokenType,
        token.scope,
        token.expiresAt,
        token.providerEmail,
      );
  }

  delete(provider: string, userId: string): void {
    this.db
      .prepare("DELETE FROM oauth_tokens WHERE provider = ? AND user_id = ?")
      .run(provider, userId);
  }

  listByUser(userId: string): OAuthToken[] {
    const rows = this.db
      .prepare(
        `SELECT provider, user_id, access_token, access_token_iv, access_token_tag,
                refresh_token, refresh_token_iv, refresh_token_tag,
                token_type, scope, expires_at, provider_email,
                created_at, updated_at
         FROM oauth_tokens
         WHERE user_id = ?
         ORDER BY provider`,
      )
      .all(userId) as RawOAuthToken[];

    const tokens: OAuthToken[] = [];
    for (const row of rows) {
      try {
        tokens.push(this.mapRow(row));
      } catch {
        console.warn(
          `[oauth-token-repo] Failed to decrypt token for provider=${row.provider} userId=${userId} — skipping`,
        );
      }
    }
    return tokens;
  }

  private mapRow(row: RawOAuthToken): OAuthToken {
    const accessToken = this.cipher.decrypt(
      row.access_token,
      row.access_token_iv,
      row.access_token_tag,
    );

    let refreshToken: string | null = null;
    if (
      row.refresh_token !== null &&
      row.refresh_token_iv !== null &&
      row.refresh_token_tag !== null
    ) {
      refreshToken = this.cipher.decrypt(
        row.refresh_token,
        row.refresh_token_iv,
        row.refresh_token_tag,
      );
    }

    return {
      provider: row.provider as OAuthProvider,
      userId: row.user_id,
      accessToken,
      refreshToken,
      tokenType: row.token_type,
      scope: row.scope,
      expiresAt: row.expires_at,
      providerEmail: row.provider_email,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

// ── Internal ─────────────────────────────────────────────────

interface RawOAuthToken {
  provider: string;
  user_id: string;
  access_token: string;
  access_token_iv: string;
  access_token_tag: string;
  refresh_token: string | null;
  refresh_token_iv: string | null;
  refresh_token_tag: string | null;
  token_type: string;
  scope: string;
  expires_at: string | null;
  provider_email: string | null;
  created_at: string;
  updated_at: string;
}
