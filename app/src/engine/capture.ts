// Passive capture (adapter-engine.md §10, adapted by spec §7). It never writes.
import type { BleTransport, CharProp, DiscoveredService } from './ble';
import { fingerprintString, type Sha256 } from './fingerprint';
import { toHex } from './hex';
import { systemClock, type Clock } from './host';
import { canonicalUUID } from './uuid';

export const CAPTURE_SECONDS = 60;
export const EVENT_CAP = 5000;
const READ_TIMEOUT_MS = 5000; // a characteristic that never answers must not stop the capture
const REDACTED_CHARS = new Set(['2A23', '2A25']); // System ID, Serial Number

export type CaptureEnd = 'timer' | 'stop' | 'disconnect' | 'dismissed' | 'background';

export interface CaptureAdvertisement {
  name: string | null;
  rssi: number;
  services: string[];
  manufacturerData: string | null;
  serviceData: Record<string, string>;
}

export interface CaptureCharacteristic {
  uuid: string;
  props: CharProp[];
  readValue: string | null;
  readError: string | null;
}

export interface CaptureDocument {
  bbqlawCapture: 2;
  app: string;
  ota: string;
  ios: string;
  endedBy: CaptureEnd;
  fingerprint: { string: string; hash: string };
  advertisement: CaptureAdvertisement;
  services: { uuid: string; characteristics: CaptureCharacteristic[] }[];
  events: { t: number; service: string; char: string; hex: string }[];
  identifyAttempts: unknown[]; // filled by the identify pipeline (OTA phase)
}

export interface CaptureSnapshot {
  phase: 'intro' | 'recording' | 'finishing' | 'done';
  secondsLeft: number;
  packets: number;
  result: { document: CaptureDocument; fileName: string } | null;
}

export interface CaptureInfo {
  app: string;
  ota: string;
  ios: string;
}

/** Keeps ASCII letters, digits, `-` and `_`. */
export function captureFileName(name: string | null, at: Date): string {
  const allowed = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';
  const safe = [...(name ?? '')].filter((c) => allowed.includes(c)).join('').slice(0, 32) || 'device';
  const two = (n: number) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}`;
  return `bbqlaw-capture-${safe}-${stamp}.json`;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class CaptureSession {
  private snapshot: CaptureSnapshot = { phase: 'intro', secondsLeft: CAPTURE_SECONDS, packets: 0, result: null };
  private listeners = new Set<() => void>();
  private discovered: DiscoveredService[] = [];
  private services: CaptureDocument['services'] = [];
  private events: CaptureDocument['events'] = [];
  private startedAt = 0;
  private cancelTick: (() => void) | null = null;
  private cleanups: (() => void)[] = [];

  constructor(
    private ble: BleTransport,
    private deviceId: string,
    private advertisement: CaptureAdvertisement,
    private claim: (deviceId: string) => () => void,
    private info: CaptureInfo,
    private sha256: Sha256,
    private clock: Clock = systemClock,
  ) {}

  getSnapshot = (): CaptureSnapshot => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  start() {
    if (this.snapshot.phase !== 'intro') return;
    this.startedAt = this.clock.now();
    this.set({ phase: 'recording' });
    const mine = (id: string) => id === this.deviceId;
    this.cleanups = [
      this.claim(this.deviceId),
      this.ble.on('connected', (e) => {
        if (mine(e.id)) this.record().catch((error) => console.warn('capture:', error));
      }),
      this.ble.on('disconnected', (e) => {
        if (mine(e.id)) void this.end('disconnect');
      }),
      this.ble.on('failedToConnect', (e) => {
        if (mine(e.id)) void this.end('disconnect');
      }),
      this.ble.on('state', (e) => {
        if (e.state !== 'poweredOn') void this.end('disconnect');
      }),
      this.ble.on('value', (e) => {
        if (mine(e.id)) this.addEvent(e.service, e.char, e.bytes);
      }),
    ];
    this.tick();
    this.ble.connect(this.deviceId).catch(() => void this.end('disconnect'));
  }

  /** Ends the recording once. Does nothing before `start()` or after the first end. */
  async end(endedBy: CaptureEnd): Promise<void> {
    if (this.snapshot.phase !== 'recording') return;
    this.set({ phase: 'finishing' });
    this.cancelTick?.();
    // Stop listening and release the device only after the cancel is queued.
    const cancelled = this.ble.cancel(this.deviceId).catch(() => undefined);
    for (const cleanup of this.cleanups.slice(1)) cleanup();
    const fingerprint = fingerprintString(this.discovered, this.advertisement.name, this.advertisement.manufacturerData);
    const hash = await this.sha256(fingerprint);
    await cancelled;
    this.cleanups[0]?.();
    this.cleanups = [];
    const document: CaptureDocument = {
      bbqlawCapture: 2,
      ...this.info,
      endedBy,
      fingerprint: { string: fingerprint, hash },
      advertisement: this.advertisement,
      services: this.services,
      events: this.events,
      identifyAttempts: [],
    };
    const fileName = captureFileName(this.advertisement.name, new Date(this.clock.now()));
    this.set({ phase: 'done', result: { document, fileName } });
  }

  private tick() {
    this.cancelTick = this.clock.schedule(1000, () => {
      const secondsLeft = Math.max(0, CAPTURE_SECONDS - Math.round((this.clock.now() - this.startedAt) / 1000));
      this.set({ secondsLeft });
      if (secondsLeft === 0) void this.end('timer');
      else this.tick();
    });
  }

  private get recording() {
    return this.snapshot.phase === 'recording';
  }

  private async record() {
    this.discovered = await this.ble.discover(this.deviceId);
    this.services = this.discovered.map((s) => ({
      uuid: s.service,
      characteristics: s.chars.map((c) => ({ uuid: c.uuid, props: c.props, readValue: null, readError: null })),
    }));
    const all = this.services.flatMap((s) => s.characteristics.map((c) => ({ service: s.uuid, c })));
    // Read each readable characteristic before any subscription.
    for (const { service, c } of all) {
      if (!c.props.includes('read')) continue;
      if (!this.recording) return;
      try {
        const bytes = await this.withTimeout(this.ble.read(this.deviceId, service, c.uuid));
        c.readValue = this.isRedacted(c.uuid) ? 'redacted' : toHex(bytes);
      } catch (error) {
        c.readError = errorText(error);
      }
    }
    for (const { service, c } of all) {
      if (!c.props.includes('notify') && !c.props.includes('indicate')) continue;
      if (!this.recording) return;
      await this.withTimeout(this.ble.setNotify(this.deviceId, service, c.uuid, true)).catch((error) =>
        console.warn(`capture: subscribe ${c.uuid}:`, errorText(error)),
      );
    }
  }

  private withTimeout<T>(work: Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const cancel = this.clock.schedule(READ_TIMEOUT_MS, () => reject(new Error('timeout')));
      work.then(resolve, reject).finally(cancel);
    });
  }

  private isRedacted(char: string) {
    return REDACTED_CHARS.has(canonicalUUID(char) ?? '');
  }

  private addEvent(service: string, char: string, bytes: number[]) {
    if (!this.recording || this.events.length >= EVENT_CAP) return;
    this.events.push({
      t: Math.max(0, Math.round(this.clock.now() - this.startedAt)),
      service,
      char,
      hex: this.isRedacted(char) ? 'redacted' : toHex(bytes),
    });
    this.set({ packets: this.events.length });
  }

  private set(patch: Partial<CaptureSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}
