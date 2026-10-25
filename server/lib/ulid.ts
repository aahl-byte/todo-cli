import crypto from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encode(n: bigint, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out = ALPHABET[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return out;
}

/** 26-char Crockford ULID: 48-bit ms timestamp, 80 random bits. */
export function ulid(): string {
  const rand = BigInt("0x" + crypto.randomBytes(10).toString("hex"));
  return encode(BigInt(Date.now()), 10) + encode(rand, 16);
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** A deterministic 26-char uid, the same as the CLI's `sync._hash_uid`:
 * "Z" + base32(sha1(parts joined by \x1f)), cut to 25 characters. */
export function hashUid(...parts: unknown[]): string {
  const digest = crypto.createHash("sha1").update(parts.map(String).join("\x1f")).digest();
  let bits = 0, value = 0, out = "";
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return "Z" + out.slice(0, 25);
}
