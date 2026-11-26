import { createRuntime, type HostEvent } from './host';
import { matchAdapter } from './match';
import type { AdapterDef, AdapterHost } from './types';
import { canonicalUUID, probeId } from './uuid';

function harness(channels = 2) {
  let host!: AdapterHost;
  const calls: string[] = [];
  const def: AdapterDef = {
    id: 'test',
    name: 'Test',
    family: 'test',
    verified: false,
    match: [{ namePrefix: 'T' }],
    signature: { service: 'FF00', chars: ['FF01'] },
    trialSafe: false,
    gatt: { notify: ['FF01'], read: [], write: ['FF00/FF02'] },
    channels,
    capabilities: ['food', 'deviceAlarm'],
    create: (h) => {
      host = h;
      return {
        onReady: () => {},
        onNotify: () => {
          throw new Error('boom');
        },
        setTarget: () => calls.push('setTarget'),
        setBuzzer: () => calls.push('setBuzzer'),
      };
    },
  };
  const events: HostEvent[] = [];
  const runtime = createRuntime(def, (e) => events.push(e));
  return { host, runtime, events, calls };
}

const types = (events: HostEvent[]) => events.map((e) => e.type);

test('write allowlist and byte checks drop bad calls', () => {
  const { host, events } = harness();
  host.write('FF03', [1]);
  host.write('junk', [1]);
  host.write('FF02', [256]);
  host.write('FF02', [1.5]);
  host.write('FF02', [true as unknown as number]);
  host.write('ff02', new Uint8Array([1, 2]));
  expect(types(events)).toEqual(['dropped', 'dropped', 'dropped', 'dropped', 'dropped', 'write']);
});

test('reading and battery input checks', () => {
  const { host, events } = harness();
  host.reading(2, { state: 'none' });
  host.reading(0, { state: 'live' });
  host.reading(0, { state: 'live', foodF: Number.NaN });
  host.reading(0, { state: 'docked', ambientF: '1' as unknown as number });
  host.battery({ base: 140, probe: -4 });
  expect(types(events)).toEqual(['dropped', 'dropped', 'dropped', 'dropped', 'battery']);
  expect(events[4]).toEqual({ type: 'battery', battery: { base: 100, probe: 0 } });
});

test('setTarget and setBuzzer need status ready; exceptions are caught', () => {
  const { host, runtime, events, calls } = harness();
  runtime.setTarget(0, 165);
  runtime.setBuzzer(0, true);
  expect(calls).toEqual([]);
  host.status('ready');
  runtime.setTarget(0, 165);
  runtime.setBuzzer(0, true);
  expect(calls).toEqual(['setTarget', 'setBuzzer']);
  runtime.notify('FF01', []);
  expect(events.at(-1)).toEqual({ type: 'exception', message: 'boom' });
});

test('invalidate cancels timers and silences the host', () => {
  jest.useFakeTimers();
  const { host, runtime, events } = harness();
  let fired = false;
  host.after(1000, () => {
    fired = true;
  });
  runtime.invalidate();
  jest.advanceTimersByTime(2000);
  host.write('FF02', [1]);
  expect(fired).toBe(false);
  expect(events).toEqual([]);
  jest.useRealTimers();
});

test('UUID rules', () => {
  expect(canonicalUUID('0000ff01-0000-1000-8000-00805f9b34fb')).toBe('FF01');
  expect(canonicalUUID('ff0g')).toBeNull();
  expect(canonicalUUID('FF001')).toBeNull();
  expect(probeId('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEE0F', 3)).toBe('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEE0C');
});

test('match ranking: most fields, then longest prefix, then id', () => {
  const make = (id: string, match: AdapterDef['match']) => ({ id, match }) as AdapterDef;
  const ad = { name: 'INT-11I-B', services: ['FF00'], manufacturerData: '34120000' };
  const short = make('b-short', [{ namePrefix: 'INT' }]);
  const long = make('c-long', [{ namePrefix: 'int-11' }]);
  const two = make('d-two', [{ service: 'FF00', manufacturerId: 0x1234 }]);
  expect(matchAdapter([short, long, two], ad)?.id).toBe('d-two');
  expect(matchAdapter([short, long], ad)?.id).toBe('c-long');
  expect(matchAdapter([make('z', short.match), make('a', short.match)], ad)?.id).toBe('a');
  expect(matchAdapter([make('x', [{}]), make('y', [{ namePrefix: 'Q' }])], ad)).toBeNull();
});
