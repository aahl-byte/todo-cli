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
