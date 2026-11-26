// Real session manager + host.ts + INT-11I-B adapter over the simulated radio.
import { ADAPTERS } from '../adapters';
import { ProbeStore } from '../state/store';
import { memoryStorage, recordingNotifier } from '../state/testSupport';
import { createBackgroundWork } from './backgroundWork';
import { SessionManager, resolveGatt } from './sessionManager';
import { createSimulatedBle, simulatedInkbird, simulatedUnknown, type SimulatedDevice } from './simulatedBle';

const A = 'AAAAAAAA-0000-0000-0000-000000000001';
const B = 'BBBBBBBB-0000-0000-0000-000000000002';

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

async function setUp(devices: SimulatedDevice[] = [simulatedInkbird(A)], cooks?: object, restored: string[] = []) {
  const ble = createSimulatedBle(devices);
  ble.restore(restored);
  const memory = memoryStorage(cooks ? { 'bbqlaw.cooks.v2': JSON.stringify(cooks) } : {});
  const notes = recordingNotifier();
  const store = new ProbeStore(memory.storage, notes.notifier);
  await store.load();
  const manager = new SessionManager(ble.transport, store, ADAPTERS, createBackgroundWork(ble.transport));
  await manager.start();
  const connectFirst = async () => {
    manager.startScan();
    await settle();
    manager.connect(store.getSnapshot().discovered[0]!);
    await settle();
  };
  return { ble, store, manager, notes, connectFirst };
}

const sent = (ble: ReturnType<typeof createSimulatedBle>) => ble.writes.map((w) => w.hex);

test('scan marks supported devices first; connect authenticates and streams', async () => {
  const { ble, store, connectFirst, manager } = await setUp([simulatedUnknown(B), simulatedInkbird(A)]);
  manager.startScan();
  await settle();
  expect(store.getSnapshot().discovered.map((d) => d.adapter?.id ?? null)).toEqual(['inkbird-int-11i-b', null]);
  await connectFirst();
  ble.notify(A, 'FF01', '02211f');
  expect(store.probes[0]).toMatchObject({
    connection: 'connected', authState: 'authed', tempF: 84.5, baseBattery: 80, probeBattery: 55,
  });
  // All notify characteristics are subscribed before the hello; battery is read after it.
  expect(ble.calls.indexOf('setNotify 2A19')).toBeLessThan(ble.calls.indexOf('read 2A19'));
  expect(sent(ble)[0]).toBe('01fb');
  // Post-ready push: clear target, then buzzer on.
  expect(sent(ble).slice(-2)).toEqual(['0a0101000000000000000006230100000000', '030b5a02']);
  expect(ble.calls).toContain('endBackgroundWork');
  expect(ble.restoreHint).toBe('Watching Probe 1');
  manager.stop();
});

test('target sync is debounced and watch only clears and mutes at once', async () => {
  const { ble, store, connectFirst, manager } = await setUp();
  await connectFirst();
  const before = ble.writes.length;
  jest.useFakeTimers({ doNotFake: ['setImmediate'] });
  store.setTarget(A, 150);
  store.setTarget(A, 165);
  expect(ble.writes.length).toBe(before);
  jest.advanceTimersByTime(500);
  jest.useRealTimers();
  expect(sent(ble).slice(before)).toEqual(['09010110744000000a1b06230100000000']);
  store.setAlarmEnabled(A, false);
  expect(sent(ble).slice(before + 1)).toEqual(['0a0101000000000000000006230100000000', '030b1101']);
  manager.stop();
});

test('an unexpected drop reconnects and authenticates again', async () => {
  const { ble, store, connectFirst, manager } = await setUp();
  await connectFirst();
  ble.notify(A, 'FF01', '02211f');
  ble.drop(A);
  await settle();
  expect(store.probes[0]).toMatchObject({ connection: 'connected', authState: 'authed', tempF: null });
  expect(sent(ble).filter((h) => h === '01fb')).toHaveLength(2);
  manager.stop();
});

test('Bluetooth off resets cards; power on resumes', async () => {
  const { ble, store, connectFirst, manager } = await setUp();
  await connectFirst();
  ble.setState('poweredOff');
  await settle();
  expect(store.getSnapshot().bluetoothOff).toBe(true);
  expect(store.probes[0]).toMatchObject({ connection: 'disconnected', authState: 'none' });
  ble.setState('poweredOn');
  await settle();
  expect(store.probes[0]).toMatchObject({ connection: 'connected', authState: 'authed' });
  manager.stop();
});

test('remove forgets the cook and does not reconnect', async () => {
  const { ble, store, connectFirst, manager } = await setUp();
  await connectFirst();
  manager.removeProbe(A);
  await settle();
  expect(store.probes).toEqual([]);
  expect(store.record(A)).toBeUndefined();
  expect(ble.isConnected(A)).toBe(false);
  manager.stop();
});

test('restoration resumes saved probes and cancels unknown peripherals', async () => {
  const cook = { name: 'Brisket', colorHex: 0xe3611f, targetF: 203, adapterId: 'inkbird-int-11i-b' };
  const { ble, store, manager } = await setUp([simulatedInkbird(A), simulatedInkbird(B)], { [A]: cook }, [A, B]);
  await settle();
  expect(store.probes.map((p) => p.id)).toEqual([A]);
  expect(store.probes[0]).toMatchObject({ name: 'Brisket', connection: 'connected', authState: 'authed' });
  expect(ble.calls).toContain(`cancel ${B}`);
  expect(ble.restoreHint).toBe('Watching Brisket · target 203°F');
  manager.stop();
});

test('a device that does not fit its adapter is dropped, forgotten and offered capture', async () => {
  const impostor = { ...simulatedUnknown(A), advertisement: simulatedInkbird(A).advertisement };
  const { ble, store, connectFirst, manager } = await setUp([impostor]);
  await connectFirst();
  expect(store.probes).toEqual([]);
  expect(store.record(A)).toBeUndefined();
  expect(store.getSnapshot().unsupportedDevice?.id).toBe(A);
  expect(ble.writes).toEqual([]);
  expect(ble.isConnected(A)).toBe(false);
  manager.stop();
});

test('gatt entries resolve SERVICE/CHAR when a UUID repeats', () => {
  const def = ADAPTERS[0]!;
  const services = [
    { service: '180F', chars: [{ uuid: 'FF02', props: [] }] },
    { service: 'FF00', chars: [{ uuid: 'FF01', props: [] }, { uuid: 'FF02', props: [] }] },
  ];
  expect(resolveGatt(def, services, 'FF02')?.service).toBe('FF00');
  expect(resolveGatt(def, services, '180F/FF02')?.service).toBe('180F');
  expect(resolveGatt(def, services, 'FF09')).toBeNull();
});
