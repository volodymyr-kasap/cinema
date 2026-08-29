import { randomFillSync } from 'node:crypto';

let lastMillis = 0;
let sequence = 0;

/**
 * RFC 9562 version 7: 48 bits of Unix milliseconds, a 12-bit counter, then 62
 * bits of randomness. PostgreSQL 18 generates these natively and the column
 * default still does (ADR 0004) -- but the seat lock's value must exist before
 * the row does, so a reservation's id is minted here and passed to the INSERT.
 *
 * Node has no v7 generator; `randomUUID()` is v4, which is unordered and would
 * cost exactly the B-tree locality ADR 0004 chose v7 for.
 */
export function uuidv7(): string {
  const now = Date.now();
  if (now > lastMillis) {
    lastMillis = now;
    sequence = 0;
  } else {
    sequence += 1;
    // 4096 ids inside one millisecond is four million a second. Borrowing from
    // the next millisecond keeps the ordering total instead of emitting a
    // duplicate sort key.
    if (sequence > 0xfff) {
      lastMillis += 1;
      sequence = 0;
    }
  }

  const bytes = Buffer.alloc(16);
  bytes.writeUIntBE(lastMillis, 0, 6);
  // Version 7 in the top nibble of byte 6; the counter fills the rest.
  bytes.writeUInt16BE(0x7000 | sequence, 6);
  randomFillSync(bytes, 8, 8);
  // Variant 10xx in the top two bits of byte 8.
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
