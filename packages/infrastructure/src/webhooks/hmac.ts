import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify an HMAC-SHA256 signature against a raw body.
 * Uses timing-safe comparison to prevent timing attacks.
 *
 * @param rawBody - The raw request body as a string or Buffer
 * @param signature - The hex-encoded HMAC signature from the request header
 * @param secret - The shared secret key
 * @returns true if the signature is valid
 */
export function verifyHmacSignature(
  rawBody: string | Buffer,
  signature: string,
  secret: string
): boolean {
  if (!signature || !secret) return false;

  const expected = createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  if (expected.length !== signature.length) return false;

  return timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(signature, "hex")
  );
}
