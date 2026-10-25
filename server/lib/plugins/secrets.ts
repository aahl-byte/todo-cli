// Connection credentials at rest: AES-256-GCM under TODO_SECRET_KEY (32 bytes,
// base64 or hex), bound to the project, repo and connection they were stored for.
import crypto from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class NoSecretKey extends Error {
  constructor() {
    super("TODO_SECRET_KEY isn't set on the server, so it can't store connection credentials");
  }
}

/** The key from TODO_SECRET_KEY, or null when it's unset or not 32 bytes. */
export function secretKey(raw = process.env.TODO_SECRET_KEY): Buffer | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const key = /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, "hex") : Buffer.from(text, "base64");
  return key.length === 32 ? key : null;
}

const aad = (scope: string[]) => Buffer.from(scope.join("\x1f"));

export function encryptSecret(plain: string, scope: string[], key = secretKey()): string {
  if (!key) throw new NoSecretKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(scope));
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64")}`;
}

/** The plaintext, or null when the key is missing or wrong or the text was stored for another scope. */
export function decryptSecret(stored: string, scope: string[], key = secretKey()): string | null {
  if (!key || !stored.startsWith(`${VERSION}:`)) return null;
  const raw = Buffer.from(stored.slice(VERSION.length + 1), "base64");
  if (raw.length < IV_BYTES + TAG_BYTES) return null;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV_BYTES));
    decipher.setAAD(aad(scope));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
