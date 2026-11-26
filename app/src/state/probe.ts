// Port of CookModel.swift and the state enums from Models.swift.
import type { Capability } from '../engine/types';

export interface Doneness {
  label: string;
  f: number;
}

export interface Meat {
  key: string;
  name: string;
  target: number | null; // null = custom (set on slider)
  doneness?: Doneness[];
}

export const MEATS: readonly Meat[] = [
  { key: 'brisket', name: 'Brisket', target: 203 },
  { key: 'pork', name: 'Pulled pork', target: 203 },
  { key: 'ribs', name: 'Ribs', target: 198 },
  { key: 'chicken', name: 'Chicken', target: 165 },
  { key: 'turkey', name: 'Turkey', target: 165 },
  { key: 'fish', name: 'Fish / salmon', target: 145 },
  { key: 'porkchop', name: 'Pork chop', target: 145 },
  {
    key: 'steak',
    name: 'Steak',
    target: 130,
    doneness: [
      { label: 'Rare', f: 120 },
      { label: 'Med rare', f: 130 },
      { label: 'Medium', f: 140 },
      { label: 'Med well', f: 150 },
      { label: 'Well', f: 160 },
    ],
  },
  { key: 'burger', name: 'Burger', target: 160 },
  { key: 'custom', name: 'Custom', target: null },
];

export const meatForKey = (key: string | null): Meat | null => MEATS.find((m) => m.key === key) ?? null;

export type ProbeMode = 'live' | 'docked' | 'noReading';
export type ConnectionState = 'connecting' | 'connected' | 'disconnected';
export type AuthState = 'none' | 'subscribing' | 'requested' | 'waiting' | 'authed' | 'failed';

/** Display + cook state for one probe channel. */
export interface Probe {
  id: string;
  deviceId: string;
  channel: number;
  adapterId: string;
  capabilities: Capability[];
  name: string;
  colorHex: number;
  meatKey: string | null;
  doneness: string | null;
  targetF: number | null;
  tempF: number | null;
  ambientF: number | null;
  mode: ProbeMode;
  probeBattery: number | null;
  baseBattery: number | null;
  connection: ConnectionState;
  authState: AuthState;
  readingNote: string | null;
  advertisedName: string | null;
  lastReadingAt: number | null;
  recentTemps: number[];
  // Alarm bookkeeping (so a mid-cook reconnect doesn't re-fire).
  targetReached: boolean;
  hasFiredAlarm: boolean;
  baseMuted: boolean;
  /** Watch only preserves the selected target but disables all target alarms. */
  alarmEnabled: boolean;
}

export const alarmTargetF = (p: Probe): number | null => (p.alarmEnabled ? p.targetF : null);
export const shouldMuteBaseBuzzer = (p: Probe): boolean => !p.alarmEnabled || p.baseMuted;
export const hasTarget = (p: Probe): boolean => alarmTargetF(p) !== null;
export function isReached(p: Probe): boolean {
  const target = alarmTargetF(p);
  return target !== null && p.mode === 'live' && p.tempF !== null && p.tempF >= target;
}

export function cookLabel(p: Probe): string {
  const base = p.meatKey === 'custom' ? 'Custom' : (meatForKey(p.meatKey)?.name ?? '—');
  return p.doneness ? `${base} · ${p.doneness}` : base;
}

export const colorString = (hex: number): string => `#${hex.toString(16).toUpperCase().padStart(6, '0')}`;

export const PROBE_COLORS: readonly number[] = [0xe3611f, 0x4a7db5, 0xe0a93c, 0x7a9b57];
