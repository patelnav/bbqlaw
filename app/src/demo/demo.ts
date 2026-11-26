// __DEV__ only: screenshots without a probe. The radio is simulated and speaks real
// INT-11I-B bytes; the session manager, host.ts and adapter are the real ones.
//   xcrun simctl launch booted app.bbqlaw.ios -bbqDemo monitoring
import { LogBox } from 'react-native';
import { createSimulatedBle, simulatedInkbird, simulatedUnknown } from '../engine/simulatedBle';
import { createServices, type Services } from '../services';
import { memoryStorage } from '../state/testSupport';
import type { DiscoveredDevice } from '../state/store';
import type { Sheet } from '../ui/Root';

const A = 'D0000000-0000-4000-8000-0000000000A1';
const B = 'D0000000-0000-4000-8000-0000000000B2';
const UNKNOWN = 'D0000000-0000-4000-8000-0000000000C3';

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** An FF01 frame: LE16 °F x 100, then the status byte. */
function temperatureFrame(f: number): string {
  const raw = Math.round(f * 100);
  return [raw & 0xff, raw >> 8, 0x1f].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function createDemo(scene: string): { services: Services; run(): Promise<Sheet | null> } {
  LogBox.ignoreAllLogs(); // no warning toast in screenshots
  const ble = createSimulatedBle([simulatedInkbird(A), simulatedUnknown(UNKNOWN), simulatedInkbird(B, 'INT-11I-B', -67)]);
  let linked =
    scene === 'settings-linked'
      ? { deviceId: 'demo', deviceToken: 'demo', ingestURL: 'https://invalid.invalid/', readerToken: 'hickory-ember-oak-482' }
      : null;
  const services = createServices({
    ble: ble.transport,
    storage: memoryStorage().storage,
    credentials: {
      load: async () => linked,
      save: async () => true,
      clear: async () => {
        linked = null;
      },
    },
    upload: async () => 'maple-smoke-pit-317',
  });

  const createCapture = services.createCapture;
  services.createCapture = (id, advertisement) => {
    const session = createCapture(id, advertisement);
    if (scene === 'capture-recording' || scene === 'capture-done') {
      setTimeout(() => {
        session.start();
        let n = 0;
        const feed = setInterval(() => ble.notify(UNKNOWN, 'FFF2', temperatureFrame(70 + (n++ % 20))), 400);
        if (scene === 'capture-done') {
          setTimeout(() => {
            clearInterval(feed);
            void session.end('stop');
          }, 3000);
        }
      }, 800);
    }
    return session;
  };

  async function discover(): Promise<DiscoveredDevice[]> {
    services.manager.startScan();
    await pause(200);
    return services.store.getSnapshot().discovered;
  }

  async function connect(id: string) {
    const device = (await discover()).find((d) => d.id === id)!;
    services.manager.connect(device);
    await pause(300);
  }

  async function stream(id: string, from: number, to: number) {
    for (let i = 0; i <= 30; i++) {
      ble.notify(id, 'FF01', temperatureFrame(from + ((to - from) * i) / 30 + Math.sin(i / 2) * 0.6));
      await pause(20);
    }
    ble.notify(id, 'FF01', temperatureFrame(to));
  }

  async function run(): Promise<Sheet | null> {
    const { store } = services;
    if (scene === 'onboarding') return null;
    if (scene === 'scanner') return { kind: 'scanner' };
    if (scene === 'unsupported' || scene.startsWith('capture')) {
      const device = (await discover()).find((d) => d.id === UNKNOWN)!;
      services.manager.stopScan();
      return { kind: 'capture', device, unreadable: scene === 'unsupported' };
    }
    await connect(A);
    if (scene === 'pairing') {
      store.mutate(A, () => ({ connection: 'connecting' }));
      return null;
    }
    store.setName(A, 'Chicken');
    if (scene !== 'notarget') store.setCook(A, 'chicken', null, scene === 'reached' ? 140 : 165);
    if (scene === 'multi' || scene.startsWith('settings')) {
      await connect(B);
      store.setName(B, 'Brisket');
      store.setCook(B, 'brisket', null, 203);
      await stream(B, 138, 156.4);
    }
    await stream(A, 96, scene === 'reached' ? 141.2 : 142.5);
    if (scene === 'docked') ble.notify(A, 'FF01', 'fe7f00');
    if (scene === 'watchonly') store.setAlarmEnabled(A, false);
    if (scene === 'meat') {
      store.setCook(A, 'steak', 'Med rare', 130);
      return { kind: 'meat', probeId: A };
    }
    if (scene.startsWith('settings')) return { kind: 'settings' };
    return null;
  }

  return { services, run };
}
