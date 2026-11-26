const DIGITS = "0123456789";
const ALNUM = `${DIGITS}abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ`;

function only(value: string, alphabet: string): boolean {
  for (const character of value) {
    if (!alphabet.includes(character)) return false;
  }
  return true;
}

/** Runtime versions, key ids and release ids: safe as one R2 key segment. */
export function isToken(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 && only(value, `${ALNUM}._-`);
}

export function isSha256Hex(value: string): boolean {
  return value.length === 64 && only(value, `${DIGITS}abcdef`);
}

/** Standard base64 with at most two trailing "=". Safe inside a quoted header string. */
export function isBase64(value: unknown): value is string {
  if (typeof value !== "string") return false;
  let end = value.length;
  while (end > 0 && value.length - end < 2 && value[end - 1] === "=") end -= 1;
  return end > 0 && only(value.slice(0, end), `${ALNUM}+/`);
}
