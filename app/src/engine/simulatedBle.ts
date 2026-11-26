// A simulated radio: the hardware boundary behind `BleTransport`. Used by jest and
// by the __DEV__-only demo (screenshots). It speaks real INT-11I-B vector bytes;
// the real session manager, host.ts and adapter run on top of it.
import { createBleEmitter, type BleState, type BleTransport, type CharProp, type DiscoveredService, type Discovery } from './ble';
import { fromHex, toHex } from './hex';

export interface SimulatedDevice {
  advertisement: Discovery;
  services: DiscoveredService[];
  reads?: Record<string, string>;
  /** Called for every write; `notify` sends a value back. */
  onWrite?(char: string, hex: string, notify: (char: string, hex: string) => void): void;
}

const chars = (uuids: string[], props: CharProp[]) => uuids.map((uuid) => ({ uuid, props }));

/** An INT-11I-B: challenge from the golden vectors, then ACK. */
export function simulatedInkbird(id: string, name = 'INT-11I-B', rssi = -54): SimulatedDevice {
  return {
    advertisement: { id, name, rssi, services: ['FF00'], manufacturerData: null, serviceData: {} },
    services: [
      {
        service: 'FF00',
        chars: [
          ...chars(['FF01'], ['notify']),
          ...chars(['FF02'], ['write', 'writeNoResponse', 'notify']),
          ...chars(['FF03', 'FF04', 'FF05', 'FF06'], ['notify']),
        ],
      },
      { service: '180F', chars: chars(['2A19'], ['read', 'notify']) },
    ],
    reads: { '2A19': '5037' },
    onWrite(char, hex, notify) {
      if (char !== 'FF02') return;
      if (hex === '01fb') notify('FF02', '07fb2a19e11e78aa');
      else if (hex.startsWith('08fc')) notify('FF02', '02fc00');
    },
  };
}

/** An iBBQ-layout thermometer. It sends data only when the test or demo calls `notify`. */
export function simulatedIbbq(id: string, name = 'iBBQ', rssi = -58): SimulatedDevice {
  return {
    advertisement: { id, name, rssi, services: ['FFF0'], manufacturerData: null, serviceData: {} },
    services: [
      {
        service: 'FFF0',
        chars: [
          ...chars(['FFF1'], ['notify']),
          ...chars(['FFF2'], ['write']),
          ...chars(['FFF3'], ['notify']),
          ...chars(['FFF4'], ['notify']),
          ...chars(['FFF5'], ['write']),
        ],
      },
    ],
    onWrite() {},
  };
}

const THERMOPRO = (n: number) => `1086FFF${n}-3343-4817-8BB2-B32206336CE8`;
/** A captured TP25 report (kwood1992/thermopro-tp25-ble): probe 1 = 30.0 °C. */
const THERMOPRO_REPORT = '300f5c0c000300ffffffffffffffffffffa00140';

/** A TP25: accepts the start frame, then answers each temperature request. */
export function simulatedThermoPro(id: string, name = 'Thermopro', rssi = -63): SimulatedDevice {
  return {
    advertisement: { id, name, rssi, services: [THERMOPRO(0)], manufacturerData: null, serviceData: {} },
    services: [
      {
        service: THERMOPRO(0),
        chars: [...chars([THERMOPRO(1)], ['read', 'write']), ...chars([THERMOPRO(2)], ['notify'])],
      },
    ],
    onWrite(char, hex, notify) {
      if (char !== THERMOPRO(1)) return;
      if (hex.startsWith('0109')) notify(THERMOPRO(2), '01010a0c');
      else if (hex === '300030') notify(THERMOPRO(2), THERMOPRO_REPORT);
    },
  };
}

export function simulatedUnknown(id: string, name = 'TM-WLP100', rssi = -61): SimulatedDevice {
  return {
    advertisement: {
      id, name, rssi, services: ['FFF0'], manufacturerData: '3412aabbccdd', serviceData: {},
    },
    services: [
      { service: '180A', chars: chars(['2A23', '2A25', '2A29'], ['read']) },
      {
        service: 'FFF0',
        chars: [...chars(['FFF1'], ['write']), ...chars(['FFF2'], ['read', 'notify'])],
      },
    ],
    reads: { '2A23': '0102030405060708', '2A25': '534e31323334', '2A29': '44656d6f', FFF2: '00ff' },
  };
}

export function createSimulatedBle(devices: SimulatedDevice[], initialState: BleState = 'poweredOn') {
  const emitter = createBleEmitter();
  const connected = new Set<string>();
  const subscribed = new Set<string>();
  const writes: { id: string; char: string; hex: string }[] = [];
  const calls: string[] = [];
  let state = initialState;
  let restored: string[] = [];
  let hint = '';
  const find = (id: string) => devices.find((d) => d.advertisement.id === id);
  const later = (fn: () => void) => void Promise.resolve().then(fn);
  const serviceOf = (device: SimulatedDevice, char: string) =>
    device.services.find((s) => s.chars.some((c) => c.uuid === char))?.service ?? '';

  /** Sends a notification when the device is connected and subscribed. */
  function notify(id: string, char: string, hex: string) {
    const device = find(id);
    if (!device || !connected.has(id) || !subscribed.has(`${id}/${char}`)) return;
    emitter.emit('value', { id, service: serviceOf(device, char), char, bytes: fromHex(hex), t: Date.now() });
  }

  function requireConnected(id: string): SimulatedDevice {
    const device = find(id);
    if (!device || !connected.has(id)) throw Object.assign(new Error('disconnected'), { code: 'disconnected' });
    return device;
  }

  function drop(id: string, error: string | null) {
    if (!connected.delete(id)) return;
    for (const key of [...subscribed]) if (key.startsWith(`${id}/`)) subscribed.delete(key);
    later(() => emitter.emit('disconnected', { id, error }));
  }

  const transport: BleTransport = {
    on: emitter.on,
    attach: async () => {},
    state: async () => state,
    startScan: async () => {
      calls.push('startScan');
      later(() => devices.forEach((d) => emitter.emit('discovered', d.advertisement)));
    },
    stopScan: async () => {},
    connect: async (id) => {
      calls.push(`connect ${id}`);
      if (!find(id) || state !== 'poweredOn') return;
      connected.add(id);
      later(() => emitter.emit('connected', { id }));
    },
    cancel: async (id) => {
      calls.push(`cancel ${id}`);
      drop(id, null);
    },
    discover: async (id) => requireConnected(id).services,
    setNotify: async (id, _service, char, on) => {
      requireConnected(id);
      calls.push(`setNotify ${char}`);
      if (on) subscribed.add(`${id}/${char}`);
      else subscribed.delete(`${id}/${char}`);
    },
    read: async (id, _service, char) => {
      calls.push(`read ${char}`);
      const hex = requireConnected(id).reads?.[char];
      if (hex === undefined) throw Object.assign(new Error('read failed'), { code: 'read_failed' });
      return fromHex(hex);
    },
    write: async (id, _service, char, bytes) => {
      const device = requireConnected(id);
      const hex = toHex(bytes);
      writes.push({ id, char, hex });
      later(() => device.onWrite?.(char, hex, (c, h) => notify(id, c, h)));
    },
    restoredIds: async () => restored,
    setRestoreHint: async (text) => {
      hint = text;
    },
    beginBackgroundWork: async () => {
      calls.push('beginBackgroundWork');
    },
    endBackgroundWork: async () => {
      calls.push('endBackgroundWork');
    },
  };

  return {
    transport,
    writes,
    calls,
    notify,
    /** The device goes out of range. */
    drop: (id: string) => drop(id, 'The connection has timed out unexpectedly.'),
    setState(next: BleState) {
      state = next;
      if (next !== 'poweredOn') connected.clear();
      later(() => emitter.emit('state', { state: next }));
    },
    restore(ids: string[]) {
      restored = ids;
    },
    get restoreHint() {
      return hint;
    },
    isConnected: (id: string) => connected.has(id),
  };
}
