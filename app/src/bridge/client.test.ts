import { adapter as inkbird } from '../adapters/inkbird-int-11i-b';
import type { Fetch } from '../engine/upload';
import { ProbeStore } from '../state/store';
import { memoryStorage, recordingNotifier } from '../state/testSupport';
import { BridgeClient, RELAY_BASE } from './client';
import { parseCredentials, type CredentialStore, type Credentials } from './credentials';

const ID = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEE00';
const settle = () => new Promise((r) => setImmediate(r));

async function setUp(saved: Credentials | null) {
  let stored = saved;
  const credentials: CredentialStore = {
    load: async () => stored,
    save: async (c) => {
      stored = c;
      return true;
    },
    clear: async () => {
      stored = null;
    },
  };
  const requests: { url: string; headers: Record<string, string>; body: any }[] = [];
  let status = 200;
  const fetcher: Fetch = async (url, init) => {
    requests.push({ url: String(url), headers: init!.headers as Record<string, string>, body: JSON.parse(String(init!.body)) });
    return {
      ok: status === 200,
      status,
      json: async () => ({
        device: 'dev-1', deviceToken: 't', readerToken: 'oak-fire-1', ingestUrl: `${RELAY_BASE}/api/ingest`,
      }),
    } as Response;
  };
  let now = 1_000_000;
  let held = 0;
  const store = new ProbeStore(memoryStorage().storage, recordingNotifier().notifier);
  const bridge = new BridgeClient(store, credentials, () => {
    held += 1;
    return () => {
      held -= 1;
    };
  }, fetcher, () => now);
  await bridge.refresh();
  store.addProbe({ ...store.makeProbe(ID, 0, 'INT-11I-B', inkbird), name: 'Brisket', connection: 'connected' });
  const reading = async (foodF: number) => {
    store.applyReading(ID, { channel: 0, state: 'live', foodF }, inkbird, null);
    store.stateChanged();
    await settle();
  };
  return {
    store, bridge, requests, reading,
    advance: (ms: number) => (now += ms),
    fail: (code: number) => (status = code),
    get held() {
      return held;
    },
    get stored() {
      return stored;
    },
  };
}

const link: Credentials = { deviceId: 'dev-1', deviceToken: 'secret', ingestURL: `${RELAY_BASE}/api/ingest` };

test('unlinked: no pushes', async () => {
  const t = await setUp(null);
  await t.reading(100);
  expect(t.requests).toEqual([]);
});

test('heartbeat is throttled; reaching target pushes at once; disconnect pushes once', async () => {
  const t = await setUp(link);
  await t.reading(100);
  t.advance(5000);
  await t.reading(101);
  expect(t.requests).toHaveLength(1);
  expect(t.requests[0]!.headers.Authorization).toBe('Bearer secret');
  expect(t.requests[0]!.body).toEqual({
    device: 'dev-1',
    ts: 1000,
    probes: [{ id: ID, name: 'Brisket', color: '#E3611F', tempF: 100, mode: 'live', connected: true }],
  });
  t.advance(15000);
  await t.reading(102);
  expect(t.requests).toHaveLength(2);
  t.store.setTarget(ID, 105);
  await t.reading(106);
  expect(t.requests).toHaveLength(3);
  await t.reading(106);
  expect(t.requests).toHaveLength(3);
  t.store.mutate(ID, () => ({ connection: 'disconnected' }));
  t.store.stateChanged();
  t.store.stateChanged();
  await settle();
  expect(t.requests).toHaveLength(4);
  expect(t.requests[3]!.body.probes[0]).toMatchObject({ connected: false, targetF: 105 });
  expect(t.requests[3]!.body.probes[0]).not.toHaveProperty('tempF');
  expect(t.held).toBe(0);
});

test('failures back off', async () => {
  const t = await setUp(link);
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  t.fail(500);
  await t.reading(100);
  expect(t.bridge.getSnapshot().lastPushError).toBe('Push failed (HTTP 500).');
  t.advance(20000);
  await t.reading(100);
  expect(t.requests).toHaveLength(1);
  t.advance(20000);
  await t.reading(100);
  expect(t.requests).toHaveLength(2);
  warn.mockRestore();
});

test('pair saves the 1.0 credential format and unlink clears it', async () => {
  const t = await setUp(null);
  expect(await t.bridge.pair()).toBe(`${RELAY_BASE}/openclaw/oak-fire-1`);
  expect(t.stored).toEqual({
    deviceId: 'dev-1', deviceToken: 't', readerToken: 'oak-fire-1', ingestURL: `${RELAY_BASE}/api/ingest`,
  });
  expect(parseCredentials(JSON.stringify(t.stored))).toEqual(t.stored);
  await t.bridge.unlink();
  expect(t.bridge.getSnapshot()).toMatchObject({ isLinked: false, shareURL: null });
});
