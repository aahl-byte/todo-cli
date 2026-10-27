// Connection credentials at rest: AES-256-GCM under TODO_SECRET_KEY (32 bytes,
// base64 or hex), bound to the project, repo and connection they were stored for.
import crypto from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class NoSecretKey extends Error {
  constructor(why = secretKeyProblem() ?? "TODO_SECRET_KEY isn't usable") {
    super(why);
  }
}

const HEX_KEY = /^[0-9a-f]{64}$/i;
/** 32 bytes in base64 (padded) or base64url (unpadded). */
const BASE64_KEY = /^[A-Za-z0-9+/]{43}=$|^[A-Za-z0-9_-]{43}$/;

/** Why TODO_SECRET_KEY can't be used, or null when it can. */
export function secretKeyProblem(raw = process.env.TODO_SECRET_KEY): string | null {
  const text = (raw ?? "").trim();
  if (!text) return "TODO_SECRET_KEY isn't set on the server, so it can't store secrets";
  if (HEX_KEY.test(text) || BASE64_KEY.test(text)) return null;
  return "TODO_SECRET_KEY must be 32 bytes, written as 64 hex characters or 44 base64 characters (openssl rand -base64 32)";
}

/** The key from TODO_SECRET_KEY, or null when it's unset or isn't exactly 32 bytes. */
export function secretKey(raw = process.env.TODO_SECRET_KEY): Buffer | null {
  if (secretKeyProblem(raw)) return null;
  const text = raw!.trim();
  return HEX_KEY.test(text) ? Buffer.from(text, "hex") : Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

const aad = (scope: string[]) => Buffer.from(scope.join("\x1f"));

/** What a project connection's secret is encrypted under: the project, the connection and the endpoint it was given for, so it
 * decrypts for no other. "*" stands where a repo connection's credential names its repo. */
export const projectSecretScope = (project: string, connection: string, endpoint: string) => [project, "*", connection, endpoint];

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
