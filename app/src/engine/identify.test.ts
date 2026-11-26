// Scoring, candidate order and the trial state machine. The real host, adapters
// and session code run over the simulated radio.
import { createHash } from 'node:crypto';
import { ADAPTERS, adapterById } from '../adapters';
import { ProbeStore } from '../state/store';
import { memoryStorage, recordingNotifier } from '../state/testSupport';
import { createBackgroundWork } from './backgroundWork';
import type { DiscoveredService } from './ble';
import { CaptureSession } from './capture';
import { fingerprintString } from './fingerprint';
import { IdentifySession } from './identify';
import { candidates, emptyScore, isDockedPass, isLivePass, scoreReading, type Score } from './scoring';
import { SessionManager } from './sessionManager';
import {
  createSimulatedBle, simulatedIbbq, simulatedInkbird, simulatedThermoPro, simulatedUnknown, type SimulatedDevice,
} from './simulatedBle';
import type { AdapterDef } from './types';

const ID = 'DDDDDDDD-0000-0000-0000-000000000004';
const sha256 = async (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const settle = async () => {
  for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r));
};

describe('scoring', () => {
  const read = (score: Score, foodF: number, channel = 0) => scoreReading(score, { channel, state: 'live', foodF }) as Score;

  test('a live pass needs ready and two live readings under 15 °F apart', () => {
    let s = read(emptyScore, 70);
    expect(s.steady).toBe(false);
    s = read(s, 85); // a step of exactly 15 does not count
    expect(s.steady).toBe(false);
    s = read(s, 99.9);
    expect(s.steady).toBe(true);
    expect(isLivePass(s)).toBe(false);
    expect(isLivePass({ ...s, ready: true })).toBe(true);
    expect(s).toMatchObject({ channel: 0, latestF: 99.9 });
  });

  test('steps are per channel; the passing channel supplies the reading', () => {
    let s = read(read(emptyScore, 70, 0), 71, 1);
    expect(s.steady).toBe(false);
    s = read(s, 72, 1);
    expect(s).toMatchObject({ steady: true, channel: 1, latestF: 72 });
    expect(read(s, 200, 0).latestF).toBe(72);
  });

  test('outside -40..750 fails; docked is a docked pass only when ready', () => {
    for (const foodF of [-40.1, 750.1]) expect(scoreReading(emptyScore, { channel: 0, state: 'live', foodF })).toBe('failed');
    for (const foodF of [-40, 750]) expect(scoreReading(emptyScore, { channel: 0, state: 'live', foodF })).not.toBe('failed');
    expect(scoreReading(emptyScore, { channel: 0, state: 'none', ambientF: 900 })).toBe('failed');
    const docked = scoreReading(emptyScore, { channel: 0, state: 'docked' }) as Score;
    expect(isDockedPass(docked)).toBe(false);
    expect(isDockedPass({ ...docked, ready: true })).toBe(true);
  });
});

describe('candidates', () => {
  const services: DiscoveredService[] = [
    { service: 'FFF0', chars: ['FFF1', 'FFF2', 'FFF4', 'FFF5'].map((uuid) => ({ uuid, props: [] })) },
  ];
  const make = (id: string, extra: Partial<AdapterDef>): AdapterDef => ({
    ...adapterById('ibbq-fff0')!, id, verified: false, signature: { service: 'FFF0', chars: ['FFF2'] }, ...extra,
  });
  const list = [
    make('small', {}),
    make('large', { signature: { service: 'fff0', chars: ['fff1', 'FFF2'] } }),
    make('verified', { verified: true }),
    make('unsafe', { trialSafe: false, verified: true }),
    make('missing-char', { signature: { service: 'FFF0', chars: ['FFF3'] } }),
    make('other-service', { signature: { service: 'FF00', chars: ['FFF2'] } }),
  ];
  const ids = (hit: string | null) => candidates(list, services, hit).map((a) => a.id);

  test('signature and trialSafe filter; fingerprint, then verified, then size', () => {
    expect(ids(null)).toEqual(['verified', 'large', 'small']);
    expect(ids('small')).toEqual(['small', 'verified', 'large']);
  });

  test('the shipped adapters', () => {
    expect(candidates(ADAPTERS, simulatedIbbq(ID).services, null).map((a) => a.id)).toEqual(['ibbq-fff0']);
    expect(candidates(ADAPTERS, simulatedThermoPro(ID).services, null).map((a) => a.id)).toEqual(['thermopro-fff0']);
    expect(candidates(ADAPTERS, simulatedInkbird(ID).services, null).map((a) => a.id)).toEqual(['inkbird-int-11i-b']);
    expect(candidates(ADAPTERS, simulatedUnknown(ID).services, null)).toEqual([]);
  });

  test('family adapters never match an advertisement', () => {
    for (const a of ADAPTERS.filter((x) => !x.verified)) expect(a.match).toEqual([]);
  });
});

/** A thermometer that has both the iBBQ and the ThermoPro layouts. */
function bothLayouts(answers: 'ibbq' | 'thermopro' | 'neither'): SimulatedDevice {
  const ibbq = simulatedIbbq(ID);
  const thermopro = simulatedThermoPro(ID);
  return {
    ...ibbq,
    services: [...ibbq.services, ...thermopro.services],
    onWrite(char, hex, notify) {
      const speaker = char.startsWith('1086') ? thermopro : ibbq;
      if (answers === (speaker === ibbq ? 'ibbq' : 'thermopro')) speaker.onWrite!(char, hex, notify);
    },
  };
}

function setUp(device: SimulatedDevice, fingerprints: Record<string, string> = {}, adapters = ADAPTERS) {
  const ble = createSimulatedBle([device]);
  const log: string[] = [];
  const noMatch: string[] = [];
  const session = new IdentifySession({
    ble: ble.transport,
    deviceId: ID,
    advertisedName: device.advertisement.name,
    manufacturerData: device.advertisement.manufacturerData,
    adapters,
    fingerprints,
    sha256,
    claim: () => {
      log.push('claim');
      return () => log.push('release');
    },
    onNoMatch: (f) => noMatch.push(f),
  });
  const phases: string[] = [];
  session.subscribe(() => {
    const { phase } = session.getSnapshot();
    if (phases.at(-1) !== phase) phases.push(phase);
  });
  return { ble, session, log, noMatch, phases };
}

/** Starts identify and lets virtual time pass. */
async function run(t: ReturnType<typeof setUp>, ms = 0) {
  if (t.session.getSnapshot().phase === 'intro') t.session.start();
  await settle();
  for (let left = ms; left > 0; left -= 1000) {
    jest.advanceTimersByTime(Math.min(1000, left));
    await settle();
  }
}

describe('trials', () => {
  beforeEach(() => jest.useFakeTimers({ doNotFake: ['setImmediate'] }));
  afterEach(() => jest.useRealTimers());

  test('nothing connects or writes before Try protocols', async () => {
    const t = setUp(simulatedIbbq(ID));
    await settle();
    expect(t.session.getSnapshot().phase).toBe('intro');
    expect(t.ble.calls).toEqual([]);
    expect(t.ble.writes).toEqual([]);
  });

  test('live pass, confirm, then the device is released', async () => {
    const t = setUp(simulatedIbbq(ID));
    await run(t);
    ['d600f6ff', 'd700f6ff'].forEach((hex) => t.ble.notify(ID, 'FFF4', hex));
    await settle();
    expect(t.session.getSnapshot()).toMatchObject({ phase: 'confirm', trial: 1, trials: 1 });
    expect(t.session.getSnapshot().readingF).toBeCloseTo(70.7, 1);
    t.ble.notify(ID, 'FFF4', 'e600f6ff');
    expect(t.session.getSnapshot().readingF).toBeCloseTo(73.4, 1);
    t.session.confirm(true);
    await run(t, 3000);
    expect(t.session.getSnapshot()).toMatchObject({ phase: 'matched', adapter: { id: 'ibbq-fff0' } });
    expect(t.session.attempts).toMatchObject([{ adapterId: 'ibbq-fff0', result: 'livePass' }]);
    expect(t.ble.isConnected(ID)).toBe(false);
    expect(t.log).toEqual(['claim', 'release']);
    expect(t.noMatch).toEqual([]);
    // Only the adapter's declared characteristics were written.
    expect([...new Set(t.ble.writes.map((w) => w.char))]).toEqual(['FFF2', 'FFF5']);
  });

  test('the ThermoPro trial passes from its start frame and reports', async () => {
    const t = setUp(simulatedThermoPro(ID));
    await run(t, 12_000);
    expect(t.session.getSnapshot()).toMatchObject({ phase: 'confirm', readingF: 86 });
    await t.session.cancel();
    expect(t.session.getSnapshot().phase).toBe('cancelled');
  });

  test('silent trials time out in order, reconnect between them, and end in noMatch', async () => {
    const t = setUp(bothLayouts('neither'));
    await run(t, 29_000);
    expect(t.session.getSnapshot()).toMatchObject({ phase: 'trying', trial: 1, trials: 2 });
    await run(t, 40_000);
    expect(t.session.getSnapshot().phase).toBe('noMatch');
    expect(t.session.attempts).toMatchObject([
      { adapterId: 'ibbq-fff0', result: 'fail', reason: 'not ready' },
      { adapterId: 'thermopro-fff0', result: 'fail', reason: 'not ready' },
    ]);
    expect(t.ble.calls.filter((c) => c.startsWith('connect') || c.startsWith('cancel'))).toEqual(
      [`connect ${ID}`, `cancel ${ID}`, `connect ${ID}`, `cancel ${ID}`],
    );
    expect(t.noMatch).toEqual([
      fingerprintString(bothLayouts('neither').services, 'iBBQ', null),
    ]);
  });

  test('"No" moves to the next candidate; a fingerprint hit goes first', async () => {
    const device = bothLayouts('thermopro');
    const hash = await sha256(fingerprintString(device.services, 'iBBQ', null));
    const t = setUp(device, { [hash]: 'thermopro-fff0' });
    await run(t, 12_000);
    expect(t.session.getSnapshot()).toMatchObject({ phase: 'confirm', trial: 1, adapter: { id: 'thermopro-fff0' } });
    t.session.confirm(false);
    await run(t, 40_000);
    expect(t.session.getSnapshot().phase).toBe('noMatch');
    expect(t.session.attempts.map((a) => [a.adapterId, a.result])).toEqual([
      ['thermopro-fff0', 'rejectedByUser'], ['ibbq-fff0', 'fail'],
    ]);
  });

  test('a reading out of range fails at once', async () => {
    const t = setUp(simulatedIbbq(ID));
    await run(t);
    t.ble.notify(ID, 'FFF4', 'ff7f'); // 3276.7 °C
    await run(t, 3000);
    expect(t.session.attempts).toMatchObject([{ result: 'fail', reason: 'reading out of range' }]);
    expect(t.session.getSnapshot().phase).toBe('noMatch');
  });

  test('docked pass asks for the probe and waits 30 s more for a live pass', async () => {
    const t = setUp(simulatedInkbird(ID));
    await run(t, 20_000);
    t.ble.notify(ID, 'FF01', 'fe7f00');
    expect(t.session.getSnapshot().phase).toBe('docked');
    await run(t, 25_000); // past the first 30 s, inside the extra 30 s
    t.ble.notify(ID, 'FF01', '02211f');
    t.ble.notify(ID, 'FF01', '02211f');
    await settle();
    expect(t.session.getSnapshot()).toMatchObject({ phase: 'confirm', readingF: 84.5 });
    await t.session.cancel();
  });

  test('docked with no live reading is a dockedPass attempt', async () => {
    const t = setUp(simulatedInkbird(ID));
    await run(t, 1000);
    t.ble.notify(ID, 'FF01', 'fe7f00');
    await run(t, 33_000);
    expect(t.session.attempts).toMatchObject([{ result: 'dockedPass', reason: 'no live reading after docked' }]);
    expect(t.session.getSnapshot().phase).toBe('noMatch');
  });

  test('an adapter exception fails the trial', async () => {
    const broken: AdapterDef = {
      ...adapterById('ibbq-fff0')!,
      create: () => ({
        onReady: () => {
          throw new Error('boom');
        },
        onNotify: () => {},
      }),
    };
    const t = setUp(simulatedIbbq(ID), {}, [broken]);
    await run(t, 3000);
    expect(t.session.attempts).toMatchObject([{ result: 'fail', reason: 'adapter exception: boom' }]);
  });

  test('losing the link while the user decides is a failure, not a rejection', async () => {
    const t = setUp(simulatedThermoPro(ID));
    await run(t, 12_000);
    t.ble.drop(ID);
    await run(t, 3000);
    expect(t.session.attempts).toMatchObject([{ result: 'fail', reason: 'disconnected' }]);
    expect(t.session.getSnapshot().phase).toBe('noMatch');
  });

  test('cancel during a trial disconnects and records nothing', async () => {
    const t = setUp(simulatedIbbq(ID));
    await run(t, 5000);
    const done = t.session.cancel();
    await run(t, 3000);
    await done;
    expect(t.ble.isConnected(ID)).toBe(false);
    expect(t.log).toEqual(['claim', 'release']);
    expect(t.noMatch).toEqual([]);
    const writes = t.ble.writes.length;
    await run(t, 40_000);
    expect(t.ble.writes).toHaveLength(writes);
  });

  test('a device that cannot be reached is an error, not a failed device', async () => {
    const t = setUp(simulatedIbbq(ID));
    t.ble.setState('poweredOff');
    await run(t, 17_000);
    expect(t.session.getSnapshot()).toMatchObject({ phase: 'error', error: 'Could not connect to the thermometer.' });
    expect(t.noMatch).toEqual([]);
  });

  test('a capture includes the identify attempts', async () => {
    const t = setUp(simulatedIbbq(ID));
    await run(t, 35_000);
    expect(t.session.getSnapshot().phase).toBe('noMatch');
    const capture = new CaptureSession(
      t.ble.transport, ID, simulatedIbbq(ID).advertisement, () => () => {},
      { app: '2.0.0 (3)', ota: 'embedded', ios: '26.1' }, sha256, undefined, t.session.attempts,
    );
    capture.start();
    await settle();
    await capture.end('stop');
    expect(capture.getSnapshot().result!.document.identifyAttempts).toEqual(t.session.attempts);
  });
});

test('a confirmed device becomes a normal probe and stays supported', async () => {
  const ble = createSimulatedBle([simulatedIbbq(ID)]);
  const store = new ProbeStore(memoryStorage().storage, recordingNotifier().notifier);
  const manager = new SessionManager(ble.transport, store, ADAPTERS, createBackgroundWork(ble.transport));
  await manager.start();
  manager.startScan();
  await settle();
  const found = store.getSnapshot().discovered[0]!;
  expect(found.adapter).toBeNull();
  manager.connect({ ...found, adapter: { id: 'ibbq-fff0', name: 'iBBQ' } });
  await settle();
  ble.notify(ID, 'FFF4', 'd600f6ff');
  expect(store.probes[0]).toMatchObject({ adapterId: 'ibbq-fff0', connection: 'connected', authState: 'authed' });
  expect(store.probes[0]!.tempF).toBeCloseTo(70.52, 2);
  expect(store.record(ID)?.adapterId).toBe('ibbq-fff0');
  manager.removeProbe(ID);
  await settle();
  manager.startScan();
  await settle();
  expect(store.getSnapshot().discovered[0]!.adapter).toBeNull();
  manager.stop();
});
