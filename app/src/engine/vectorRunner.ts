// adapter-engine.md §9: golden vector semantics, run through the real host.ts.
import { fromHex, toHex } from './hex';
import { createRuntime, type Clock, type HostEvent } from './host';
import type { AdapterDef } from './types';
import { canonicalUUID } from './uuid';

export interface VectorStep {
  ready?: boolean;
  notify?: { char: string; hex: string };
  setTarget?: { channel: number; highF: number | null };
  setBuzzer?: { channel: number; muted: boolean };
  advance?: number;
}

export interface VectorCase {
  name: string;
  nowMs?: number;
  steps: VectorStep[];
  expect: {
    writes?: { char: string; hex: string; withResponse?: boolean }[];
    readings?: unknown[];
    battery?: unknown[];
    status?: string[];
  };
}

function virtualClock(startMs: number) {
  let elapsed = 0;
  let sequence = 0;
  const timers: { due: number; sequence: number; fn: () => void }[] = [];
  const clock: Clock = {
    now: () => startMs + elapsed,
    schedule(ms, fn) {
      const timer = { due: elapsed + ms, sequence: sequence++, fn };
      timers.push(timer);
      return () => {
        const i = timers.indexOf(timer);
        if (i >= 0) timers.splice(i, 1);
      };
    },
  };
  function advance(ms: number) {
    const target = elapsed + ms;
    for (let fired = 0; ; fired++) {
      if (fired > 10000) throw new Error('advance: too many timers');
      timers.sort((a, b) => a.due - b.due || a.sequence - b.sequence);
      const next = timers[0];
      if (!next || next.due > target) break;
      timers.shift();
      elapsed = next.due;
      next.fn();
    }
    elapsed = target;
  }
  return { clock, advance };
}

export function runVector(def: AdapterDef, testCase: VectorCase) {
  const record = {
    writes: [] as { char: string; hex: string; withResponse: boolean }[],
    readings: [] as unknown[],
    battery: [] as unknown[],
    status: [] as string[],
  };
  const problems: string[] = [];
  const { clock, advance } = virtualClock(testCase.nowMs ?? 0);
  const runtime = createRuntime(
    def,
    (event: HostEvent) => {
      if (event.type === 'write') {
        record.writes.push({ char: event.char, hex: toHex(event.bytes), withResponse: event.withResponse });
      } else if (event.type === 'reading') record.readings.push(event.reading);
      else if (event.type === 'battery') record.battery.push(event.battery);
      else if (event.type === 'status') record.status.push(event.status);
      else if (event.type === 'exception') problems.push(event.message);
    },
    clock,
  );
  for (const step of testCase.steps) {
    if (step.ready) runtime.ready();
    else if (step.notify) {
      const char = canonicalUUID(step.notify.char);
      if (char === null) throw new Error(`bad notify UUID ${step.notify.char}`);
      runtime.notify(char, fromHex(step.notify.hex));
    } else if (step.setTarget) runtime.setTarget(step.setTarget.channel, step.setTarget.highF);
    else if (step.setBuzzer) runtime.setBuzzer(step.setBuzzer.channel, step.setBuzzer.muted);
    else if (typeof step.advance === 'number') advance(step.advance);
    else throw new Error(`unknown step ${JSON.stringify(step)}`);
  }
  if (problems.length > 0) throw new Error(problems.join('; '));
  const expected = {
    ...testCase.expect,
    ...(testCase.expect.writes
      ? {
          writes: testCase.expect.writes.map((w) => ({
            char: canonicalUUID(w.char),
            hex: w.hex,
            withResponse: w.withResponse ?? false,
          })),
        }
      : {}),
  };
  return { record, expected };
}

/** Deep equality; numbers compare with tolerance 0.001; key sets must be equal. */
export function matches(actual: unknown, expected: unknown): boolean {
  if (typeof expected === 'number') return typeof actual === 'number' && Math.abs(actual - expected) <= 0.001;
  if (expected === null || typeof expected !== 'object') return actual === expected;
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual) !== Array.isArray(expected)) return false;
  const keys = Object.keys(expected);
  const a = actual as Record<string, unknown>;
  const e = expected as Record<string, unknown>;
  return keys.length === Object.keys(a).length && keys.every((k) => k in a && matches(a[k], e[k]));
}
