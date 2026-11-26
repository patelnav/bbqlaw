// The GATT fingerprint (spec §6). The string format is frozen.
import type { CharProp, DiscoveredService } from './ble';
import { manufacturerIdOf } from './match';
import { canonicalUUID } from './uuid';

const PROP_ORDER: readonly CharProp[] = ['read', 'write', 'writeNoResponse', 'notify', 'indicate'];
const EXCLUDED_SERVICES = new Set(['1800', '1801']);
const DIGITS = '0123456789';

/** SHA-256 lowercase hex (`expo-crypto` in the app). */
export type Sha256 = (text: string) => Promise<string>;

/** The advertised name up to the first digit, uppercased. */
function namePrefix(name: string | null): string {
  const chars = [...(name ?? '')];
  const firstDigit = chars.findIndex((c) => DIGITS.includes(c));
  return chars.slice(0, firstDigit < 0 ? chars.length : firstDigit).join('').toUpperCase();
}

export function fingerprintString(
  services: DiscoveredService[],
  advertisedName: string | null,
  manufacturerData: string | null,
): string {
  const lines: string[] = [];
  for (const service of services) {
    const serviceUUID = canonicalUUID(service.service) ?? service.service;
    if (EXCLUDED_SERVICES.has(serviceUUID)) continue;
    for (const char of service.chars) {
      const props = PROP_ORDER.filter((p) => char.props.includes(p)).join('+') || '-';
      lines.push(`${serviceUUID}/${canonicalUUID(char.uuid) ?? char.uuid}:${props}`);
    }
  }
  lines.sort(); // UUIDs are ASCII, so this is byte order
  const manufacturer = manufacturerIdOf(manufacturerData);
  const mfr = manufacturer === null ? '' : manufacturer.toString(16).padStart(4, '0');
  return `${lines.join('\n')}\nname:${namePrefix(advertisedName)}\nmfr:${mfr}`;
}
