// Probe state, cook mutators, persistence and alarms. No Bluetooth here: the
// session manager registers itself as the device-alarm port.
import type { RecordedBattery, RecordedReading } from '../engine/host';
import type { AdapterDef } from '../engine/types';
import { probeId } from '../engine/uuid';
import { evaluateAlarm } from './alarms';
import type { Notifier } from './notifications';
import { COOKS_KEY, UNITS_KEY, parseCooks, type KeyValueStorage, type PersistedCook } from './persistence';
import { PROBE_COLORS, type Probe } from './probe';

export const LEGACY_ADAPTER_ID = 'inkbird-int-11i-b';
const MAX_CHANNELS = 8;
const RECENT_CAP = 60;

export interface DiscoveredDevice {
  id: string;
  name: string; // "Unknown" when the device has no name
  advertisedName: string | null;
  rssi: number;
  services: string[];
  manufacturerData: string | null;
  serviceData: Record<string, string>;
  adapter: { id: string; name: string } | null;
}

export interface Snapshot {
  probes: Probe[];
  discovered: DiscoveredDevice[];
  bluetoothOff: boolean;
  scanning: boolean;
  lastError: string | null;
  /** A matched device whose GATT does not fit its adapter (spec §5). */
  unsupportedDevice: DiscoveredDevice | null;
  /** Set by a user-initiated connect, so the UI selects that card. */
  connectRequest: string | null;
  useCelsius: boolean;
}

export interface DeviceAlarmPort {
  /** Debounced (0.5 s) target sync. */
  scheduleTargetSync(probeId: string): void;
  /** Push target and buzzer state now. */
  pushAlarm(probeId: string): void;
  pushBuzzer(probeId: string): void;
}

const noDevices: DeviceAlarmPort = { scheduleTargetSync() {}, pushAlarm() {}, pushBuzzer() {} };

export class ProbeStore {
  devices: DeviceAlarmPort = noDevices;
  private snapshot: Snapshot = {
    probes: [],
    discovered: [],
    bluetoothOff: false,
    scanning: false,
    lastError: null,
    unsupportedDevice: null,
    connectRequest: null,
    useCelsius: false,
  };
  private cooks: Record<string, PersistedCook> = {};
  private listeners = new Set<() => void>();
  private stateListeners = new Set<() => void>();
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private storage: KeyValueStorage,
    private notifier: Notifier,
    private now: () => number = Date.now,
  ) {}

  async load(): Promise<void> {
    const [cooks, units] = await Promise.all([this.storage.getItem(COOKS_KEY), this.storage.getItem(UNITS_KEY)]);
    this.cooks = parseCooks(cooks);
    this.set({ useCelsius: units === 'true' });
  }

  getSnapshot = (): Snapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Fired on each reading and connection change (the OpenClaw bridge uses it). */
  onStateChange(listener: () => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  stateChanged() {
    for (const listener of this.stateListeners) listener();
  }

  set(patch: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Resolves when every queued storage write is done. */
  flush(): Promise<unknown> {
    return this.writes;
  }

  setUseCelsius(useCelsius: boolean) {
    this.set({ useCelsius });
    this.write(UNITS_KEY, String(useCelsius));
  }

  // Probes

  get probes(): Probe[] {
    return this.snapshot.probes;
  }

  probe(id: string): Probe | undefined {
    return this.probes.find((p) => p.id === id);
  }

  record(id: string): PersistedCook | undefined {
    return this.cooks[id];
  }

  makeProbe(deviceId: string, channel: number, advertisedName: string | null, adapter: AdapterDef): Probe {
    const id = probeId(deviceId, channel);
    const saved = this.cooks[id];
    const index = this.probes.length;
    return {
      id,
      deviceId,
      channel,
      adapterId: adapter.id,
      capabilities: adapter.capabilities,
      name: saved?.name ?? `Probe ${index + 1}`,
      colorHex: saved?.colorHex ?? PROBE_COLORS[index % PROBE_COLORS.length]!,
      meatKey: saved?.meatKey ?? null,
      doneness: saved?.doneness ?? null,
      targetF: saved?.targetF ?? null,
      baseMuted: saved?.baseMuted ?? false,
      alarmEnabled: saved?.alarmEnabled ?? true,
      tempF: null,
      ambientF: null,
      mode: 'noReading',
      probeBattery: null,
      baseBattery: null,
      connection: 'connecting',
      authState: 'none',
      readingNote: null,
      advertisedName,
      lastReadingAt: null,
      recentTemps: [],
      targetReached: false,
      hasFiredAlarm: false,
    };
  }

  addProbe(probe: Probe) {
    if (!this.probe(probe.id)) this.set({ probes: [...this.probes, probe] });
  }

  mutate(id: string, change: (p: Probe) => Partial<Probe>) {
    this.set({ probes: this.probes.map((p) => (p.id === id ? { ...p, ...change(p) } : p)) });
  }

  mutateDevice(deviceId: string, change: (p: Probe) => Partial<Probe>) {
    this.set({ probes: this.probes.map((p) => (p.deviceId === deviceId ? { ...p, ...change(p) } : p)) });
  }

  removeDeviceCards(deviceId: string) {
    this.set({
      probes: this.probes.filter((p) => p.deviceId !== deviceId),
      ...(this.snapshot.connectRequest === deviceId ? { connectRequest: null } : {}),
    });
  }

  /** Deletes every saved record for a device. */
  forgetDevice(deviceId: string) {
    for (let channel = 0; channel < MAX_CHANNELS; channel++) delete this.cooks[probeId(deviceId, channel)];
    this.persistCooks();
  }

  saveCook(id: string) {
    const p = this.probe(id);
    if (!p) return;
    this.cooks[id] = {
      name: p.name,
      colorHex: p.colorHex,
      meatKey: p.meatKey,
      doneness: p.doneness,
      targetF: p.targetF,
      baseMuted: p.baseMuted,
      alarmEnabled: p.alarmEnabled,
      adapterId: p.adapterId,
    };
    this.persistCooks();
  }

  // Cook mutators (persist per probe so a reconnect restores the cook)

  setName(id: string, name: string) {
    this.mutate(id, () => ({ name }));
    this.saveCook(id);
    this.stateChanged();
  }

  setTarget(id: string, targetF: number | null) {
    this.mutate(id, (p) => {
      if (!p.alarmEnabled || targetF === null || p.tempF === null || p.mode !== 'live') {
        return { targetF, targetReached: false, hasFiredAlarm: false };
      }
      const reached = targetF <= p.tempF;
      return { targetF, targetReached: reached, hasFiredAlarm: reached };
    });
    this.saveCook(id);
    this.stateChanged();
    this.devices.scheduleTargetSync(id);
  }

  /** Apply a meat/doneness selection (and its preset target, unless null). */
  setCook(id: string, meatKey: string | null, doneness: string | null, target: number | null) {
    this.mutate(id, () => ({
      meatKey,
      doneness,
      ...(target !== null ? { targetF: target, hasFiredAlarm: false, targetReached: false } : {}),
    }));
    this.evaluate(id);
    this.saveCook(id);
    this.stateChanged();
    this.devices.scheduleTargetSync(id);
  }

  /** Stop app alerts and clear/mute the base alarm without losing the cook target. */
  setAlarmEnabled(id: string, enabled: boolean) {
    const existing = this.probe(id);
    if (!existing || existing.alarmEnabled === enabled) return;
    this.mutate(id, () => ({ alarmEnabled: enabled, targetReached: false, hasFiredAlarm: false }));
    if (enabled) this.evaluate(id);
    else this.notifier.cancel(id);
    this.saveCook(id);
    this.devices.pushAlarm(id);
    this.stateChanged();
  }

  setBaseMuted(id: string, baseMuted: boolean) {
    this.mutate(id, () => ({ baseMuted }));
    this.saveCook(id);
    this.stateChanged();
    this.devices.pushBuzzer(id);
  }

  // Device data

  /** Returns true when this reading created a new channel card. */
  applyReading(deviceId: string, reading: RecordedReading, adapter: AdapterDef, channelBattery: number | null): boolean {
    const id = probeId(deviceId, reading.channel);
    let isNewCard = false;
    if (!this.probe(id)) {
      // A later channel gets a card on its first live reading.
      const first = this.probes.find((p) => p.deviceId === deviceId);
      if (reading.state !== 'live' || !first) return false;
      this.addProbe({
        ...this.makeProbe(deviceId, reading.channel, first.advertisedName, adapter),
        connection: first.connection,
        authState: first.authState,
        baseBattery: first.baseBattery,
        probeBattery: channelBattery,
      });
      isNewCard = true;
    }
    this.mutate(id, (p) => {
      const common: Partial<Probe> = { lastReadingAt: this.now() };
      if (typeof reading.ambientF === 'number') common.ambientF = reading.ambientF;
      if (reading.state === 'live') {
        if (typeof reading.foodF !== 'number') return common;
        return {
          ...common,
          tempF: reading.foodF,
          mode: 'live',
          readingNote: null,
          recentTemps: [...p.recentTemps, reading.foodF].slice(-RECENT_CAP),
        };
      }
      const docked = reading.state === 'docked';
      return {
        ...common,
        tempF: null,
        mode: docked ? 'docked' : 'noReading',
        targetReached: false,
        readingNote: !docked
          ? 'No probe reading'
          : (p.probeBattery ?? 0) >= 100
            ? 'Docked · battery full'
            : 'Charging in base station',
      };
    });
    if (reading.state === 'live') this.evaluate(id);
    return isNewCard;
  }

  /** Base level goes to every card of the device; probe level to its channel. */
  applyBattery(deviceId: string, patch: RecordedBattery) {
    this.mutateDevice(deviceId, (p) => ({
      ...(patch.base !== undefined ? { baseBattery: patch.base } : {}),
      ...(patch.probe !== undefined && p.channel === (patch.channel ?? 0) ? { probeBattery: patch.probe } : {}),
    }));
  }

  resetReadings(deviceId: string) {
    // hasFiredAlarm persists across reconnects (hysteresis re-arms it).
    this.mutateDevice(deviceId, () => ({
      tempF: null,
      ambientF: null,
      mode: 'noReading',
      targetReached: false,
      readingNote: null,
      authState: 'none',
    }));
  }

  private evaluate(id: string) {
    const current = this.probe(id);
    if (!current) return;
    const { probe, alert } = evaluateAlarm(current);
    if (probe !== current) this.mutate(id, () => probe);
    if (alert) this.notifier.fire(alert);
  }

  private persistCooks() {
    this.write(COOKS_KEY, JSON.stringify(this.cooks));
  }

  private write(key: string, value: string) {
    this.writes = this.writes.then(() => this.storage.setItem(key, value)).catch((e) => console.warn('storage:', e));
  }
}
