import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export interface SealedSecret {
  /** The data key, encrypted under the master key. */
  wrappedKey: string;
  /** The secret, encrypted under the data key. */
  ciphertext: string;
}

function masterKey(masterKeyB64: string): Buffer {
  const key = Buffer.from(masterKeyB64, "base64");
  if (key.length !== 32) throw new Error("Master key must be base64 of exactly 32 bytes");
  return key;
}

// Layout of each layer: base64(iv | tag | encrypted).
function encrypt(key: Buffer, plaintext: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}

function decrypt(key: Buffer, payload: string): Buffer {
  const raw = Buffer.from(payload, "base64");
  if (raw.length < IV_LENGTH + TAG_LENGTH) throw new Error("Sealed secret is malformed");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV_LENGTH));
  decipher.setAuthTag(raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH));
  return Buffer.concat([decipher.update(raw.subarray(IV_LENGTH + TAG_LENGTH)), decipher.final()]);
}

/** Envelope encryption: a fresh 32-byte data key per secret, AES-256-GCM for both layers. */
export function sealSecret(plaintext: string, masterKeyB64: string): SealedSecret {
  const master = masterKey(masterKeyB64);
  const dataKey = randomBytes(32);
  return {
    wrappedKey: encrypt(master, dataKey),
    ciphertext: encrypt(dataKey, Buffer.from(plaintext, "utf8")),
  };
}

export function openSecret(sealed: SealedSecret, masterKeyB64: string): string {
  const dataKey = decrypt(masterKey(masterKeyB64), sealed.wrappedKey);
  return decrypt(dataKey, sealed.ciphertext).toString("utf8");
}
