import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96 bits — recommended for GCM
const TAG_LENGTH = 16; // 128 bits
const SALT = "oneon-oauth-tokens";
const KEY_LENGTH = 32; // 256 bits

// ── Key Rotation Policy ──────────────────────────────────────
// The derived key is deterministic: same encryptionKey + SALT → same AES key.
// Changing OAUTH_TOKEN_ENCRYPTION_KEY invalidates ALL stored tokens.
// After rotation, users must re-authorize their OAuth connections.
// The repository layer catches decrypt failures gracefully and returns null,
// so the app treats rotated tokens as "provider not connected."

export interface EncryptedPayload {
  ciphertext: string; // hex
  iv: string; // hex
  tag: string; // hex (GCM auth tag)
}

export class TokenCipher {
  private readonly derivedKey: Buffer;

  constructor(encryptionKey: string) {
    this.derivedKey = scryptSync(encryptionKey, SALT, KEY_LENGTH);
  }

  encrypt(plaintext: string): EncryptedPayload {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.derivedKey, iv, {
      authTagLength: TAG_LENGTH,
    });

    const encrypted = Buffer.concat([
      cipher.update(plaintext, "utf-8"),
      cipher.final(),
    ]);

    const tag = cipher.getAuthTag();

    return {
      ciphertext: encrypted.toString("hex"),
      iv: iv.toString("hex"),
      tag: tag.toString("hex"),
    };
  }

  decrypt(ciphertext: string, iv: string, tag: string): string {
    const decipher = createDecipheriv(
      ALGORITHM,
      this.derivedKey,
      Buffer.from(iv, "hex"),
      { authTagLength: TAG_LENGTH },
    );

    decipher.setAuthTag(Buffer.from(tag, "hex"));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "hex")),
      decipher.final(),
    ]);

    return decrypted.toString("utf-8");
  }
}
