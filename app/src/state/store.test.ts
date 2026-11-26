// The first four tests are the cases of BBQlawTests/WatchOnlyTests.swift.
import { adapter as inkbird } from '../adapters/inkbird-int-11i-b';
import { COOKS_KEY } from './persistence';
import { alarmTargetF, hasTarget, isReached, shouldMuteBaseBuzzer } from './probe';
import { restoreHint } from './restoreHint';
import { ProbeStore, type DeviceAlarmPort } from './store';
import { memoryStorage, recordingNotifier } from './testSupport';

const ID = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEE00';

function setUp() {
  const memory = memoryStorage();
  const notes = recordingNotifier();
  const store = new ProbeStore(memory.storage, notes.notifier);
  store.addProbe({
    ...store.makeProbe(ID, 0, 'INT-11I-B', inkbird),
    name: 'Test probe', meatKey: 'chicken', targetF: 165, tempF: 120, mode: 'live', connection: 'connected',
  });
  return { store, memory, notes };
}

async function reload(store: ProbeStore, memory: ReturnType<typeof memoryStorage>) {
  await store.flush();
  const next = new ProbeStore(memory.storage, recordingNotifier().notifier);
  await next.load();
  return next.makeProbe(ID, 0, null, inkbird);
}

const probe = (store: ProbeStore) => store.probes[0]!;

test('watch only suppresses reached state and keeps temperature and target', () => {
  const { store, notes } = setUp();
  store.setAlarmEnabled(ID, false);
  store.setCook(ID, 'chicken', null, 100);
  const p = probe(store);
  expect(p.alarmEnabled).toBe(false);
  expect(alarmTargetF(p)).toBeNull();
  expect(hasTarget(p)).toBe(false);
  expect(isReached(p)).toBe(false);
  expect(p).toMatchObject({ targetReached: false, hasFiredAlarm: false, tempF: 120, targetF: 100, mode: 'live' });
  expect(shouldMuteBaseBuzzer(p)).toBe(true);
  store.setTarget(ID, 110);
  expect(probe(store)).toMatchObject({ targetReached: false, hasFiredAlarm: false });
  expect(notes.fired).toEqual([]);
  expect(notes.cancelled).toEqual([ID]);
});

test('restoring alarm mode uses the saved target and buzzer preference', () => {
  const { store, notes } = setUp();
  store.setAlarmEnabled(ID, false);
  store.setAlarmEnabled(ID, true);
  expect(probe(store).alarmEnabled).toBe(true);
  expect(alarmTargetF(probe(store))).toBe(165);
  expect(shouldMuteBaseBuzzer(probe(store))).toBe(false);
  store.setCook(ID, 'custom', null, 100);
  expect(isReached(probe(store))).toBe(true);
  expect(probe(store).hasFiredAlarm).toBe(true);
  expect(notes.fired).toEqual([
    { probeId: ID, title: '🔥 Test probe hit target', body: 'Test probe reached 120°F (target 100°F).' },
  ]);
  store.setAlarmEnabled(ID, false);
  expect(probe(store).hasFiredAlarm).toBe(false);
  store.setBaseMuted(ID, true);
  store.setAlarmEnabled(ID, true);
  expect(shouldMuteBaseBuzzer(probe(store))).toBe(true);
});

test('watch mode and target persist across reloads', async () => {
  const { store, memory } = setUp();
  store.setBaseMuted(ID, true);
  store.setAlarmEnabled(ID, false);
  const restored = await reload(store, memory);
  expect(restored).toMatchObject({ alarmEnabled: false, targetF: 165, meatKey: 'chicken', baseMuted: true });
  expect(shouldMuteBaseBuzzer(restored)).toBe(true);
  store.setAlarmEnabled(ID, true);
  const enabled = await reload(store, memory);
  expect(enabled.alarmEnabled).toBe(true);
  expect(alarmTargetF(enabled)).toBe(165);
});

test('saved cooks without alarmEnabled keep alarm mode', async () => {
  const { store, memory } = setUp();
  store.setTarget(ID, 165);
  await store.flush();
  const saved = JSON.parse(memory.data.get(COOKS_KEY)!);
  delete saved[ID].alarmEnabled;
  memory.data.set(COOKS_KEY, JSON.stringify(saved));
  const next = new ProbeStore(memory.storage, recordingNotifier().notifier);
  await next.load();
  const restored = next.makeProbe(ID, 0, null, inkbird);
  expect(restored.alarmEnabled).toBe(true);
  expect(alarmTargetF(restored)).toBe(165);
  expect(shouldMuteBaseBuzzer(restored)).toBe(false);
});

test('alarm fires once and re-arms below target - 2', () => {
  const { store, notes } = setUp();
  const live = (foodF: number) => store.applyReading(ID, { channel: 0, state: 'live', foodF }, inkbird, null);
  live(165);
  live(166);
  live(163); // not below 163
  live(165);
  expect(notes.fired).toHaveLength(1);
  live(162.9);
  live(165);
  expect(notes.fired).toHaveLength(2);
});

test('docked and missing readings keep the notes; recent temps cap at 60', () => {
  const { store } = setUp();
  for (let i = 0; i < 70; i++) store.applyReading(ID, { channel: 0, state: 'live', foodF: 100 + i }, inkbird, null);
  expect(probe(store).recentTemps).toHaveLength(60);
  store.applyBattery(ID, { base: 80, probe: 100 });
  store.applyReading(ID, { channel: 0, state: 'docked' }, inkbird, null);
  expect(probe(store)).toMatchObject({ tempF: null, mode: 'docked', readingNote: 'Docked · battery full' });
  store.applyReading(ID, { channel: 0, state: 'none' }, inkbird, null);
  expect(probe(store)).toMatchObject({ mode: 'noReading', readingNote: 'No probe reading' });
});

test('a later channel gets a card on its first live reading', () => {
  const { store } = setUp();
  expect(store.applyReading(ID, { channel: 1, state: 'docked' }, inkbird, null)).toBe(false);
  expect(store.applyReading(ID, { channel: 1, state: 'live', foodF: 90, ambientF: 225 }, inkbird, 40)).toBe(true);
  expect(store.probes[1]).toMatchObject({
    id: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEE01', deviceId: ID, tempF: 90, ambientF: 225, probeBattery: 40,
  });
  store.applyBattery(ID, { base: 70, probe: 10, channel: 1 });
  expect(store.probes.map((p) => [p.baseBattery, p.probeBattery])).toEqual([[70, null], [70, 10]]);
});

test('restore hint', () => {
  const { store } = setUp();
  expect(restoreHint(store.probes, false)).toBe('Watching Test probe · target 165°F');
  expect(restoreHint(store.probes, true)).toBe('Watching Test probe · target 74°C');
  const port: DeviceAlarmPort = { scheduleTargetSync() {}, pushAlarm() {}, pushBuzzer() {} };
  store.devices = port;
  store.setAlarmEnabled(ID, false);
  expect(restoreHint(store.probes, false)).toBe('Watching Test probe');
  expect(restoreHint([], false)).toBe('');
});
