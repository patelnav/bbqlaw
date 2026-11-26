// The shape of the `bbq-ble` native module (spec §4.2). Types only, so engine code
// and jest do not load the native module.
export type BleState = 'poweredOn' | 'poweredOff' | 'unauthorized' | 'unsupported' | 'resetting' | 'unknown';
export type CharProp = 'read' | 'write' | 'writeNoResponse' | 'notify' | 'indicate';

export interface DiscoveredService {
  service: string;
  chars: { uuid: string; props: CharProp[] }[];
}

export interface Discovery {
  id: string;
  name: string | null;
  rssi: number;
  services: string[];
  manufacturerData: string | null;
  serviceData: Record<string, string>;
}

export interface BleEvents {
  state: { state: BleState };
  discovered: Discovery;
  connected: { id: string };
  disconnected: { id: string; error: string | null };
  failedToConnect: { id: string; error: string };
  value: { id: string; service: string; char: string; bytes: number[]; t: number };
  restored: { ids: string[] };
}

export const BLE_EVENT_NAMES: readonly (keyof BleEvents)[] = [
  'state', 'discovered', 'connected', 'disconnected', 'failedToConnect', 'value', 'restored',
];

export interface BleTransport {
  /** Returns an unsubscribe function. */
  on<K extends keyof BleEvents>(name: K, listener: (event: BleEvents[K]) => void): () => void;
  /** Flushes the events that were queued before JS listened. */
  attach(): Promise<void>;
  state(): Promise<BleState>;
  startScan(): Promise<void>;
  stopScan(): Promise<void>;
  connect(id: string): Promise<void>;
  cancel(id: string): Promise<void>;
  discover(id: string): Promise<DiscoveredService[]>;
  setNotify(id: string, service: string | null, char: string, on: boolean): Promise<void>;
  read(id: string, service: string | null, char: string): Promise<number[]>;
  write(id: string, service: string | null, char: string, bytes: number[], withResponse: boolean): Promise<void>;
  restoredIds(): Promise<string[]>;
  setRestoreHint(text: string): Promise<void>;
  beginBackgroundWork(ms: number): Promise<void>;
  endBackgroundWork(): Promise<void>;
}

/** One event hub for every listener, so native listeners attach exactly once. */
export function createBleEmitter() {
  const listeners = new Map<keyof BleEvents, Set<(event: never) => void>>();
  return {
    on<K extends keyof BleEvents>(name: K, listener: (event: BleEvents[K]) => void) {
      let set = listeners.get(name);
      if (!set) listeners.set(name, (set = new Set()));
      set.add(listener as (event: never) => void);
      return () => {
        listeners.get(name)?.delete(listener as (event: never) => void);
      };
    },
    emit<K extends keyof BleEvents>(name: K, event: BleEvents[K]) {
      for (const listener of [...(listeners.get(name) ?? [])]) {
        (listener as (e: BleEvents[K]) => void)(event);
      }
    },
  };
}
