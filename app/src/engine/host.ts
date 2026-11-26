// adapter-engine.md §7: the adapter host. The same file runs in the app and in jest.
import type { AdapterDef, AdapterHost, AdapterInstance, AdapterStatus } from './types';
import { parseGattRef } from './uuid';

export interface Clock {
  now(): number;
  /** Returns a cancel function. */
  schedule(ms: number, fn: () => void): () => void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  schedule: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

export interface RecordedReading {
  channel: number;
  state: 'live' | 'docked' | 'none';
  foodF?: number | null;
  ambientF?: number | null;
}

export interface RecordedBattery {
  base?: number | null;
  probe?: number | null;
  channel?: number;
}

export type HostEvent =
  | { type: 'write'; char: string; bytes: number[]; withResponse: boolean }
  | { type: 'reading'; reading: RecordedReading }
  | { type: 'battery'; battery: RecordedBattery }
  | { type: 'status'; status: AdapterStatus; reason?: string }
  | { type: 'exception'; message: string }
  | { type: 'dropped'; why: string }
  | { type: 'log'; message: string };

export interface AdapterRuntime {
  readonly status: AdapterStatus | 'subscribing';
  ready(): void;
  notify(char: string, bytes: number[]): void;
  /** Dispatched only when status is `ready` and the adapter has `deviceAlarm`. */
  setTarget(channel: number, highF: number | null): void;
  setBuzzer(channel: number, muted: boolean): void;
  /** Cancels all timers. Every later call and host call does nothing. */
  invalidate(): void;
}

const STATUSES: readonly string[] = ['authenticating', 'waiting', 'ready', 'failed'];
const READING_STATES: readonly string[] = ['live', 'docked', 'none'];

/** A JS array or typed array of integers 0–255, else null. */
export function readBytes(value: unknown): number[] | null {
  const typed = ArrayBuffer.isView(value) && typeof (value as { length?: unknown }).length === 'number';
  if (!Array.isArray(value) && !typed) return null;
  const source = value as ArrayLike<unknown>;
  const out: number[] = [];
  for (let i = 0; i < source.length; i++) {
    const b = source[i];
    if (typeof b !== 'number' || !Number.isInteger(b) || b < 0 || b > 255) return null;
    out.push(b);
  }
  return out;
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clampPercent = (v: number) => Math.min(100, Math.max(0, v));

/** Copy the keys the adapter passed; null stays null. Returns false on a bad value. */
function copyNumbers(
  source: object,
  keys: readonly string[],
  into: Record<string, unknown>,
  transform: (v: number) => number = (v) => v,
): boolean {
  for (const key of keys) {
    const v = (source as Record<string, unknown>)[key];
    if (v === undefined) continue;
    if (v === null) into[key] = null;
    else if (isFiniteNumber(v)) into[key] = transform(v);
    else return false;
  }
  return true;
}

export function createRuntime(
  def: AdapterDef,
  onEvent: (event: HostEvent) => void,
  clock: Clock = systemClock,
): AdapterRuntime {
  const writable = new Set<string>();
  for (const entry of def.gatt.write) {
    const ref = parseGattRef(entry);
    if (ref) writable.add(ref.char);
  }
  const deviceAlarm = def.capabilities.includes('deviceAlarm');
  const timers = new Set<() => void>();
  let status: AdapterStatus | 'subscribing' = 'subscribing';
  let alive = true;

  const emit = (event: HostEvent) => {
    if (alive) onEvent(event);
  };
  const drop = (why: string) => emit({ type: 'dropped', why });
  const validChannel = (c: unknown): c is number =>
    typeof c === 'number' && Number.isInteger(c) && c >= 0 && c < def.channels;

  const guard = (fn: () => void) => {
    if (!alive) return;
    try {
      fn();
    } catch (error) {
      emit({ type: 'exception', message: error instanceof Error ? error.message : String(error) });
    }
  };

  function write(char: unknown, bytes: unknown, withResponse: boolean) {
    const ref = parseGattRef(char);
    if (ref === null || !writable.has(ref.char)) return drop(`write to ${String(char)} is not allowed`);
    const data = readBytes(bytes);
    if (data === null) return drop('write: bad bytes');
    emit({ type: 'write', char: ref.char, bytes: data, withResponse });
  }

  const host: AdapterHost = {
    write: (char, bytes) => write(char, bytes, false),
    writeWithResponse: (char, bytes) => write(char, bytes, true),
    reading(channel, r) {
      if (!validChannel(channel)) return drop('reading: bad channel');
      if (typeof r !== 'object' || r === null || !READING_STATES.includes(r.state)) {
        return drop('reading: bad state');
      }
      const out: Record<string, unknown> = { channel, state: r.state };
      if (!copyNumbers(r, ['foodF', 'ambientF'], out)) return drop('reading: bad number');
      if (r.state === 'live' && !isFiniteNumber(out.foodF)) return drop('reading: live needs foodF');
      emit({ type: 'reading', reading: out as unknown as RecordedReading });
    },
    battery(b) {
      if (typeof b !== 'object' || b === null) return drop('battery: not an object');
      const out: Record<string, unknown> = {};
      if (!copyNumbers(b, ['base', 'probe'], out, clampPercent)) return drop('battery: bad number');
      if (b.channel !== undefined && b.channel !== null) {
        if (!validChannel(b.channel)) return drop('battery: bad channel');
        out.channel = b.channel;
      }
      emit({ type: 'battery', battery: out as RecordedBattery });
    },
    status(next, reason) {
      if (!alive) return;
      if (!STATUSES.includes(next)) return drop(`status: unknown ${String(next)}`);
      status = next;
      emit(typeof reason === 'string' ? { type: 'status', status: next, reason } : { type: 'status', status: next });
    },
    after(ms, fn) {
      if (!alive) return;
      if (!isFiniteNumber(ms) || typeof fn !== 'function') return drop('after: bad arguments');
      const cancel = clock.schedule(Math.max(0, ms), () => {
        timers.delete(cancel);
        guard(fn);
      });
      timers.add(cancel);
    },
    nowMs: () => clock.now(),
    log: (message) => emit({ type: 'log', message: String(message) }),
  };

  let instance: AdapterInstance | null = def.create(host);
  const gateOpen = () => status === 'ready' && deviceAlarm;

  return {
    get status() {
      return status;
    },
    ready: () => guard(() => instance?.onReady()),
    notify: (char, bytes) => guard(() => instance?.onNotify(char, bytes)),
    setTarget(channel, highF) {
      if (!gateOpen() || !validChannel(channel)) return;
      if (highF !== null && !isFiniteNumber(highF)) return;
      guard(() => instance?.setTarget?.(channel, highF));
    },
    setBuzzer(channel, muted) {
      if (!gateOpen() || !validChannel(channel)) return;
      guard(() => instance?.setBuzzer?.(channel, muted));
    },
    invalidate() {
      alive = false;
      for (const cancel of timers) cancel();
      timers.clear();
      instance = null;
    },
  };
}
