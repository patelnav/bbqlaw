// adapter-engine.md §4. Character checks only (no regex).
const HEX = '0123456789abcdefABCDEF';
const BASE_SUFFIX = '-0000-1000-8000-00805F9B34FB';

export const isHex = (s: string): boolean => [...s].every((c) => HEX.includes(c));

/** Canonical UUID string, or null when invalid. */
export function canonicalUUID(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length === 4) return isHex(value) ? value.toUpperCase() : null;
  if (value.length !== 36) return null;
  for (let i = 0; i < 36; i++) {
    const hyphen = i === 8 || i === 13 || i === 18 || i === 23;
    const c = value.charAt(i);
    if (hyphen ? c !== '-' : !HEX.includes(c)) return null;
  }
  const upper = value.toUpperCase();
  return upper.startsWith('0000') && upper.endsWith(BASE_SUFFIX) ? upper.slice(4, 8) : upper;
}

/** A `gatt` entry: "CHAR", or "SERVICE/CHAR" when a UUID repeats across services. */
export interface GattRef {
  service: string | null;
  char: string;
}

export function parseGattRef(value: unknown): GattRef | null {
  if (typeof value !== 'string') return null;
  const parts = value.split('/');
  if (parts.length > 2) return null;
  const char = canonicalUUID(parts[parts.length - 1]);
  if (char === null) return null;
  if (parts.length === 1) return { service: null, char };
  const service = canonicalUUID(parts[0]);
  return service === null ? null : { service, char };
}

/** Channel 0 = the device id. Channel n > 0 = the id with its last byte XOR n. */
export function probeId(deviceId: string, channel: number): string {
  if (channel === 0) return deviceId;
  const lastByte = parseInt(deviceId.slice(-2), 16);
  return deviceId.slice(0, -2) + ((lastByte ^ channel) & 0xff).toString(16).padStart(2, '0').toUpperCase();
}
