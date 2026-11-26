import { requireNativeModule } from 'expo';
import { BLE_EVENT_NAMES, createBleEmitter, type BleTransport } from '../../src/engine/ble';

type Native = Omit<BleTransport, 'on'> & {
  addListener(name: string, listener: (event: never) => void): { remove(): void };
};

export function createNativeBle(): BleTransport {
  const native = requireNativeModule<Native>('BbqBle');
  const emitter = createBleEmitter();
  // Subscribe to every event before attach() flushes the native queue.
  for (const name of BLE_EVENT_NAMES) {
    native.addListener(name, (event) => emitter.emit(name, event));
  }
  return {
    on: emitter.on,
    attach: () => native.attach(),
    state: () => native.state(),
    startScan: () => native.startScan(),
    stopScan: () => native.stopScan(),
    connect: (id) => native.connect(id),
    cancel: (id) => native.cancel(id),
    discover: (id) => native.discover(id),
    setNotify: (id, service, char, on) => native.setNotify(id, service, char, on),
    read: (id, service, char) => native.read(id, service, char),
    write: (id, service, char, bytes, withResponse) => native.write(id, service, char, bytes, withResponse),
    restoredIds: () => native.restoredIds(),
    setRestoreHint: (text) => native.setRestoreHint(text),
    beginBackgroundWork: (ms) => native.beginBackgroundWork(ms),
    endBackgroundWork: () => native.endBackgroundWork(),
  };
}
