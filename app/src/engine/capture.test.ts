import { createHash } from 'node:crypto';
import { ProbeStore } from '../state/store';
import { memoryStorage, recordingNotifier } from '../state/testSupport';
import { createBackgroundWork } from './backgroundWork';
import { CAPTURE_SECONDS, CaptureSession, EVENT_CAP, captureFileName } from './capture';
import { SessionManager } from './sessionManager';
import { fingerprintString } from './fingerprint';
import { createSimulatedBle, simulatedUnknown } from './simulatedBle';
import { CAPTURES_URL, UPLOAD_LIMIT_BYTES, uploadBody, uploadCapture, utf8Length, type Fetch } from './upload';

const ID = 'CCCCCCCC-0000-0000-0000-000000000003';
const sha256 = async (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
};

test('fingerprint golden vector (frozen format)', async () => {
  const text = fingerprintString(
    [
      { service: '1800', chars: [{ uuid: '2A00', props: ['read'] }] },
      {
        service: '0000fff0-0000-1000-8000-00805f9b34fb',
        chars: [
          { uuid: 'FFF2', props: ['indicate', 'notify', 'read'] },
          { uuid: 'FFF1', props: ['writeNoResponse', 'write'] },
        ],
      },
      { service: '1801', chars: [{ uuid: '2A05', props: ['indicate'] }] },
      { service: '180A', chars: [{ uuid: '2A29', props: [] }] },
    ],
    'tm-wlp100b',
    '3412aabb',
  );
  expect(text).toBe(
    '180A/2A29:-\nFFF0/FFF1:write+writeNoResponse\nFFF0/FFF2:read+notify+indicate\nname:TM-WLP\nmfr:1234',
  );
  expect(await sha256(text)).toBe(GOLDEN_HASH);
  expect(fingerprintString([], null, '12')).toBe('\nname:\nmfr:');
});

const GOLDEN_HASH = '7b317a769e0895df9a92aecc4e3591c8cbac6913956f0e7bffecadadf268d4cb';

function setUp() {
  const ble = createSimulatedBle([simulatedUnknown(ID)]);
  const claims: string[] = [];
  const session = new CaptureSession(
    ble.transport,
    ID,
    simulatedUnknown(ID).advertisement,
    (id) => {
      claims.push(`claim ${id}`);
      return () => claims.push('release');
    },
    { app: '2.0.0 (3)', ota: 'embedded', ios: '26.1' },
    sha256,
  );
  return { ble, session, claims };
}

test('reads then subscribes, redacts identifiers, never writes, and records v2', async () => {
  const { ble, session, claims } = setUp();
  session.start();
  await settle();
  ble.notify(ID, 'FFF2', '0102');
  expect(session.getSnapshot()).toMatchObject({ phase: 'recording', packets: 1 });
  await session.end('stop');
  await session.end('dismissed');
  const { document, fileName } = session.getSnapshot().result!;
  expect(ble.writes).toEqual([]);
  expect(ble.isConnected(ID)).toBe(false);
  expect(claims).toEqual([`claim ${ID}`, 'release']);
  expect(ble.calls.filter((c) => c.startsWith('read') || c.startsWith('setNotify'))).toEqual([
    'read 2A23', 'read 2A25', 'read 2A29', 'read FFF2', 'setNotify FFF2',
  ]);
  expect(document).toMatchObject({
    bbqlawCapture: 2, app: '2.0.0 (3)', ota: 'embedded', ios: '26.1', endedBy: 'stop', identifyAttempts: [],
    events: [{ service: 'FFF0', char: 'FFF2', hex: '0102' }],
  });
  expect(document.services[0]!.characteristics.map((c) => c.readValue)).toEqual(['redacted', 'redacted', '44656d6f']);
  expect(document.fingerprint.hash).toBe(await sha256(document.fingerprint.string));
  expect(fileName.startsWith('bbqlaw-capture-TM-WLP100-')).toBe(true);
});

test('ends on the timer and on disconnect; caps events', async () => {
  jest.useFakeTimers({ doNotFake: ['setImmediate'] });
  const timed = setUp();
  timed.session.start();
  await settle();
  for (let i = 0; i < EVENT_CAP + 10; i++) timed.ble.notify(ID, 'FFF2', '00');
  jest.advanceTimersByTime(CAPTURE_SECONDS * 1000);
  await settle();
  jest.useRealTimers();
  expect(timed.session.getSnapshot().result!.document.endedBy).toBe('timer');
  expect(timed.session.getSnapshot().result!.document.events).toHaveLength(EVENT_CAP);

  const dropped = setUp();
  dropped.session.start();
  await settle();
  dropped.ble.drop(ID);
  await settle();
  expect(dropped.session.getSnapshot().result!.document.endedBy).toBe('disconnect');
});

test('file name keeps only safe characters', () => {
  const at = new Date(2026, 10, 26, 9, 5);
  expect(captureFileName('Thermo/Máven ../x', at)).toBe('bbqlaw-capture-ThermoMvenx-20261126-0905.json');
  expect(captureFileName(null, at)).toBe('bbqlaw-capture-device-20261126-0905.json');
});

test('upload posts the document and returns the code; long captures fit 512 KB', async () => {
  const { session } = setUp();
  session.start();
  await settle();
  await session.end('stop');
  const document = session.getSnapshot().result!.document;
  const calls: [string, string | undefined][] = [];
  const fetcher: Fetch = async (url, init) => {
    calls.push([String(url), init?.method]);
    return { ok: true, status: 200, json: async () => ({ code: 'oak-fire-pit-123' }) } as Response;
  };
  expect(await uploadCapture(document, fetcher)).toBe('oak-fire-pit-123');
  expect(calls).toEqual([[CAPTURES_URL, 'POST']]);
  await expect(uploadCapture(document, async () => ({ ok: false, status: 500 }) as Response)).rejects.toThrow('HTTP 500');

  const huge = {
    ...document,
    events: Array.from({ length: EVENT_CAP }, (_, t) => ({
      t, service: '0000fff0-aaaa-1000-8000-00805f9b34fb', char: '0000fff1-aaaa-1000-8000-00805f9b34fb', hex: 'ab'.repeat(40),
    })),
  };
  const body = uploadBody(huge);
  expect(utf8Length(body)).toBeLessThanOrEqual(UPLOAD_LIMIT_BYTES);
  expect(JSON.parse(body).events.length).toBeGreaterThan(1000);
});

test('the session manager ignores a claimed device', async () => {
  const ble = createSimulatedBle([simulatedUnknown(ID)]);
  const store = new ProbeStore(memoryStorage().storage, recordingNotifier().notifier);
  const manager = new SessionManager(ble.transport, store, [], createBackgroundWork(ble.transport));
  await manager.start();
  const session = new CaptureSession(
    ble.transport, ID, simulatedUnknown(ID).advertisement, (id) => manager.claim(id),
    { app: 'a', ota: 'embedded', ios: '1' }, sha256,
  );
  session.start();
  await settle();
  expect(ble.calls.filter((c) => c === `cancel ${ID}`)).toEqual([]);
  expect(ble.isConnected(ID)).toBe(true);
  await session.end('stop');
  manager.stop();
});
