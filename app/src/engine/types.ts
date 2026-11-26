export type ReadingState = 'live' | 'docked' | 'none';
export type AdapterStatus = 'authenticating' | 'waiting' | 'ready' | 'failed';
export type Capability = 'food' | 'ambient' | 'battery' | 'docked' | 'deviceAlarm';

export interface Reading {
  state: ReadingState;
  foodF?: number | null;
  ambientF?: number | null;
}

/** Patch: an omitted key keeps the old value; null clears it. */
export interface BatteryPatch {
  base?: number | null;
  probe?: number | null;
  channel?: number | null;
}

/** The only API an adapter has (adapter-engine.md §7). */
export interface AdapterHost {
  write(char: string, bytes: ArrayLike<number>): void;
  writeWithResponse(char: string, bytes: ArrayLike<number>): void;
  reading(channel: number, reading: Reading): void;
  battery(patch: BatteryPatch): void;
  status(status: AdapterStatus, reason?: string): void;
  after(ms: number, fn: () => void): void;
  nowMs(): number;
  log(message: string): void;
}

export interface AdapterInstance {
  onReady(): void;
  /** `char` is the canonical UUID. */
  onNotify(char: string, bytes: number[]): void;
  setTarget?(channel: number, highF: number | null): void;
  setBuzzer?(channel: number, muted: boolean): void;
}

/** adapter-engine.md §5: all present fields must match; a rule needs at least one. */
export interface MatchRule {
  namePrefix?: string;
  service?: string;
  manufacturerId?: number;
}

export interface AdapterDef {
  id: string;
  name: string;
  family: string;
  verified: boolean;
  match: MatchRule[];
  signature: { service: string; chars: string[] };
  trialSafe: boolean;
  gatt: { notify: string[]; read: string[]; write: string[] };
  channels: number;
  capabilities: Capability[];
  create(host: AdapterHost): AdapterInstance;
}
