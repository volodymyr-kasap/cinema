/**
 * k6 has no crypto.randomUUID. The API validates X-Session-Id with z.uuid(),
 * so this has to be a real v4 -- version nibble and variant bits included.
 */
export function uuid() {
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += '-';
    else if (i === 14) out += '4';
    else if (i === 19) out += hex[8 + ((Math.random() * 4) | 0)];
    else out += hex[(Math.random() * 16) | 0];
  }
  return out;
}
