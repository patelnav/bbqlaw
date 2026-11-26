export const COOKS_KEY = 'bbqlaw.cooks.v2';
export const UNITS_KEY = 'useCelsius';

/** AsyncStorage's shape. */
export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface PersistedCook {
  name: string;
  colorHex: number;
  meatKey: string | null;
  doneness: string | null;
  targetF: number | null;
  baseMuted?: boolean;
  alarmEnabled?: boolean;
  adapterId?: string;
}

/** An unreadable blob gives an empty map; a bad record is skipped. */
export function parseCooks(text: string | null): Record<string, PersistedCook> {
  if (text === null) return {};
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof data !== 'object' || data === null) return {};
  const out: Record<string, PersistedCook> = {};
  for (const [id, value] of Object.entries(data as Record<string, Partial<PersistedCook> | null>)) {
    if (typeof value?.name !== 'string' || typeof value.colorHex !== 'number') continue;
    out[id] = {
      ...value,
      name: value.name,
      colorHex: value.colorHex,
      meatKey: value.meatKey ?? null,
      doneness: value.doneness ?? null,
      targetF: typeof value.targetF === 'number' ? value.targetF : null,
    };
  }
  return out;
}
