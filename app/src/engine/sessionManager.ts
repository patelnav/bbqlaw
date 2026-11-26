// Bluetooth sessions: scan, connect, discovery barrier, adapter runtime,
// reconnect, restoration, device alarm.
import { LEGACY_ADAPTER_ID, type DiscoveredDevice, type ProbeStore } from '../state/store';
import { alarmTargetF, shouldMuteBaseBuzzer, type AuthState } from '../state/probe';
import { restoreHint } from '../state/restoreHint';
import type { HoldBackgroundWork } from './backgroundWork';
import type { BleState, BleTransport, CharProp, Discovery, DiscoveredService } from './ble';
import { createRuntime, systemClock, type AdapterRuntime, type Clock, type HostEvent } from './host';
import { matchAdapter } from './match';
import type { AdapterDef, AdapterStatus } from './types';
import { canonicalUUID, parseGattRef } from './uuid';

const TARGET_DEBOUNCE_MS = 500;

const AUTH_STATE: Record<AdapterStatus, AuthState> = {
  authenticating: 'requested',
  waiting: 'waiting',
  ready: 'authed',
  failed: 'failed',
};

export interface ResolvedChar {
  service: string;
  char: string;
  props: CharProp[];
}

/** Resolves one `gatt` entry to a (service, char) on this peripheral. */
export function resolveGatt(adapter: AdapterDef, services: DiscoveredService[], entry: string): ResolvedChar | null {
  const ref = parseGattRef(entry);
  if (!ref) return null;
  const wanted = new Set(
    [...adapter.gatt.notify, ...adapter.gatt.read, ...adapter.gatt.write].map((e) => parseGattRef(e)?.char),
  );
  // When two services share a UUID, prefer the one with more of the adapter's characteristics.
  const score = (s: DiscoveredService) => s.chars.filter((c) => wanted.has(canonicalUUID(c.uuid) ?? '')).length;
  let best: { service: DiscoveredService; props: CharProp[] } | null = null;
  for (const service of services) {
    if (ref.service !== null && canonicalUUID(service.service) !== ref.service) continue;
    const found = service.chars.find((c) => canonicalUUID(c.uuid) === ref.char);
    if (found && (!best || score(service) > score(best.service))) best = { service, props: found.props };
  }
  return best ? { service: best.service.service, char: ref.char, props: best.props } : null;
}

interface Session {
  deviceId: string;
  adapter: AdapterDef;
  device: DiscoveredDevice | null; // null for a restored session
  runtime: AdapterRuntime | null;
  chars: Map<string, ResolvedChar>; // by canonical char UUID
  channelBattery: Map<number, number | null>;
  /** Changes on every reset, so late async work is ignored. */
  generation: number;
  linked: boolean;
  releaseAuthWork: (() => void) | null;
}

const errorCode = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : '';
};
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class SessionManager {
  private sessions = new Map<string, Session>();
  private rejectedRestores = new Set<string>();
  /** Devices a capture owns. The manager ignores their events. */
  private claimed = new Set<string>();
  private targetTimers = new Map<string, () => void>();
  private bleState: BleState = 'unknown';
  private lastHint: string | null = null;
  private unsubscribes: (() => void)[] = [];

  constructor(
    readonly ble: BleTransport,
    readonly store: ProbeStore,
    private adapters: readonly AdapterDef[],
    private holdBackgroundWork: HoldBackgroundWork,
    private clock: Clock = systemClock,
    private log: (message: string) => void = () => {},
  ) {
    store.devices = {
      scheduleTargetSync: (id) => this.scheduleTargetSync(id),
      pushAlarm: (id) => this.pushAlarm(id),
      pushBuzzer: (id) => this.pushBuzzer(id),
    };
  }

  /** Call after `store.load()`. */
  async start(): Promise<void> {
    this.unsubscribes = [
      this.ble.on('state', (e) => this.handleState(e.state)),
      this.ble.on('discovered', (e) => this.handleDiscovered(e)),
      this.ble.on('connected', (e) => this.handleConnected(e.id)),
      this.ble.on('disconnected', (e) => this.handleDisconnected(e.id, e.error)),
      this.ble.on('failedToConnect', (e) => this.handleFailedToConnect(e.id, e.error)),
      this.ble.on('value', (e) => this.handleValue(e.id, e.service, e.char, e.bytes)),
      this.ble.on('restored', (e) => this.handleRestored(e.ids)),
      this.store.subscribe(() => this.updateRestoreHint()),
    ];
    await this.ble.attach();
    this.handleRestored(await this.ble.restoredIds());
    this.handleState(await this.ble.state());
    this.updateRestoreHint();
  }

  stop() {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes = [];
    for (const session of this.sessions.values()) this.resetSession(session);
    for (const cancel of this.targetTimers.values()) cancel();
    this.targetTimers.clear();
  }

  // Public API

  startScan() {
    if (this.bleState !== 'poweredOn') return;
    this.store.set({ discovered: [], scanning: true });
    this.ble.startScan().catch((e) => this.fail(e));
  }

  stopScan() {
    this.ble.stopScan().catch((e) => this.fail(e));
    this.store.set({ scanning: false });
  }

  /** Add a supported device. The same path for the first and every later one. */
  connect(device: DiscoveredDevice) {
    const adapter = this.adapters.find((a) => a.id === device.adapter?.id);
    if (!adapter) return;
    this.stopScan();
    const id = device.id;
    if (this.sessions.has(id)) return;
    this.sessions.set(id, this.newSession(id, adapter, device));
    this.store.addProbe(this.store.makeProbe(id, 0, device.name, adapter));
    this.store.mutateDevice(id, () => ({
      connection: 'connecting',
      advertisedName: device.name,
      adapterId: adapter.id,
      capabilities: adapter.capabilities,
    }));
    this.store.saveCook(id);
    this.store.set({ connectRequest: id });
    this.ble.connect(id).catch((e) => this.fail(e));
  }

  /** Remove a thermometer: every channel of the probe's device is disconnected and forgotten. */
  removeProbe(probeIdToRemove: string) {
    const deviceId = this.store.probe(probeIdToRemove)?.deviceId ?? probeIdToRemove;
    this.dropDevice(deviceId);
    this.store.forgetDevice(deviceId);
    this.store.stateChanged();
  }

  dismissUnsupported() {
    this.store.set({ unsupportedDevice: null });
  }

  /** Gives a device to a capture. Release it when the capture ends. */
  claim(deviceId: string): () => void {
    this.claimed.add(deviceId);
    return () => {
      this.claimed.delete(deviceId);
    };
  }

  // Events

  private handleState(state: BleState) {
    // The same state can arrive twice (queued event, then `state()`).
    if (state === 'unknown' || state === this.bleState) return;
    this.bleState = state;
    if (state === 'poweredOn') {
      this.store.set({ bluetoothOff: false });
      for (const id of this.rejectedRestores) this.ble.cancel(id).catch(() => undefined);
      this.rejectedRestores.clear();
      // Resume any interrupted sessions.
      for (const session of this.sessions.values()) {
        if (!session.linked) this.attemptReconnect(session.deviceId);
      }
      return;
    }
    this.store.set({ bluetoothOff: true, scanning: false });
    for (const session of this.sessions.values()) {
      this.resetSession(session);
      this.store.resetReadings(session.deviceId);
      this.store.mutateDevice(session.deviceId, () => ({ connection: 'disconnected' }));
    }
    this.store.stateChanged();
  }

  private handleRestored(ids: string[]) {
    for (const id of ids) {
      if (this.sessions.has(id) || this.rejectedRestores.has(id)) continue;
      const record = this.store.record(id);
      const adapter = record && this.adapters.find((a) => a.id === (record.adapterId ?? LEGACY_ADAPTER_ID));
      if (!adapter) {
        // No saved cook, or its adapter is gone. Cancel once powered on.
        this.rejectedRestores.add(id);
        if (this.bleState === 'poweredOn') this.ble.cancel(id).catch(() => undefined);
        continue;
      }
      this.sessions.set(id, this.newSession(id, adapter, null));
      this.store.addProbe(this.store.makeProbe(id, 0, null, adapter));
      if (this.bleState === 'poweredOn') this.attemptReconnect(id);
    }
  }

  private handleDiscovered(found: Discovery) {
    // Hide probes we're already connected to.
    if (this.store.probes.some((p) => p.deviceId === found.id && p.connection === 'connected')) return;
    const matched =
      matchAdapter(this.adapters, found) ??
      this.adapters.find((a) => a.id === this.store.record(found.id)?.adapterId) ??
      null;
    const device: DiscoveredDevice = {
      id: found.id,
      name: found.name ?? 'Unknown',
      advertisedName: found.name,
      rssi: found.rssi,
      services: found.services,
      manufacturerData: found.manufacturerData,
      serviceData: found.serviceData,
      adapter: matched ? { id: matched.id, name: matched.name } : null,
    };
    const others = this.store.getSnapshot().discovered.filter((d) => d.id !== found.id);
    const discovered = [...others, device].sort(
      (a, b) => Number(b.adapter !== null) - Number(a.adapter !== null) || b.rssi - a.rssi,
    );
    this.store.set({ discovered });
  }

  private handleConnected(id: string) {
    if (this.claimed.has(id)) return;
    const session = this.sessions.get(id);
    if (!session) {
      // Removed during the connect window: don't resurrect it.
      this.ble.cancel(id).catch(() => undefined);
      return;
    }
    this.resetSession(session);
    session.linked = true;
    this.store.mutateDevice(id, () => ({ connection: 'connected' }));
    this.store.set({ lastError: null });
    this.store.stateChanged();
    this.discover(session).catch((e) => this.fail(e));
  }

  private handleFailedToConnect(id: string, error: string) {
    if (this.claimed.has(id) || !this.sessions.has(id)) return;
    this.store.set({ lastError: error });
    this.attemptReconnect(id);
  }

  private handleDisconnected(id: string, error: string | null) {
    if (this.claimed.has(id)) return;
    const session = this.sessions.get(id);
    if (!session) return; // removed by the user
    if (error !== null) this.store.set({ lastError: error });
    this.resetSession(session);
    this.store.resetReadings(id);
    this.attemptReconnect(id); // unexpected drop mid-cook: keep trying
    this.store.stateChanged();
  }

  private handleValue(id: string, service: string, char: string, bytes: number[]) {
    if (this.claimed.has(id)) return;
    const session = this.sessions.get(id);
    const uuid = canonicalUUID(char);
    if (!session?.runtime || uuid === null) return;
    const resolved = session.chars.get(uuid);
    if (resolved && resolved.service !== service) return; // same UUID in another service
    session.runtime.notify(uuid, bytes);
  }

  // Session

  private newSession(deviceId: string, adapter: AdapterDef, device: DiscoveredDevice | null): Session {
    return {
      deviceId,
      adapter,
      device,
      runtime: null,
      chars: new Map(),
      channelBattery: new Map(),
      generation: 0,
      linked: false,
      releaseAuthWork: null,
    };
  }

  private resetSession(session: Session) {
    session.generation += 1;
    session.runtime?.invalidate();
    session.runtime = null;
    session.chars.clear();
    session.channelBattery.clear();
    session.linked = false;
    session.releaseAuthWork?.();
    session.releaseAuthWork = null;
  }

  private attemptReconnect(id: string) {
    if (!this.sessions.has(id)) return;
    this.store.mutateDevice(id, () => ({ connection: 'connecting' }));
    // Pending until it succeeds; iOS honours it in the background.
    this.ble.connect(id).catch((e) => this.log(`connect ${id}: ${errorText(e)}`));
  }

  private async discover(session: Session) {
    const generation = session.generation;
    const current = () => session.generation === generation && this.sessions.get(session.deviceId) === session;
    const id = session.deviceId;

    let services: DiscoveredService[];
    try {
      services = await this.ble.discover(id);
    } catch (error) {
      // A drop during discovery is handled by the disconnect path.
      const code = errorCode(error);
      if (current() && code !== 'disconnected' && !code.startsWith('bluetooth_')) this.mismatch(session);
      return;
    }
    if (!current()) return;

    const { gatt } = session.adapter;
    for (const entry of [...gatt.notify, ...gatt.read, ...gatt.write]) {
      const resolved = resolveGatt(session.adapter, services, entry);
      if (resolved) session.chars.set(resolved.char, resolved);
    }
    if (session.chars.size === 0) {
      this.mismatch(session);
      return;
    }

    session.runtime = createRuntime(
      session.adapter,
      (event) => {
        if (current()) this.handleHostEvent(session, event);
      },
      this.clock,
    );
    this.store.mutateDevice(id, () => ({ authState: 'subscribing' }));

    // Subscribe every notify characteristic BEFORE onReady: some devices only
    // start their handshake once all of them are subscribed.
    const subscriptions = new Map<string, ResolvedChar>();
    for (const entry of gatt.notify) {
      const resolved = resolveGatt(session.adapter, services, entry);
      if (resolved && (resolved.props.includes('notify') || resolved.props.includes('indicate'))) {
        subscriptions.set(`${resolved.service}/${resolved.char}`, resolved);
      } else {
        this.log(`no notify characteristic ${entry}; skipped`);
      }
    }
    await Promise.all(
      [...subscriptions.values()].map((c) =>
        this.ble.setNotify(id, c.service, c.char, true).catch((error) => {
          this.log(`subscribe ${c.char}: ${errorText(error)}`);
          if (current()) this.store.set({ lastError: errorText(error) });
        }),
      ),
    );
    if (!current()) return;
    session.runtime?.ready();

    for (const entry of gatt.read) {
      const resolved = resolveGatt(session.adapter, services, entry);
      if (!resolved || !resolved.props.includes('read')) continue;
      try {
        const bytes = await this.ble.read(id, resolved.service, resolved.char);
        if (!current()) return;
        session.runtime?.notify(resolved.char, bytes);
      } catch (error) {
        this.log(`read ${resolved.char}: ${errorText(error)}`);
      }
    }
  }

  /** A matched device whose GATT does not fit its adapter (spec §5). */
  private mismatch(session: Session) {
    const id = session.deviceId;
    this.log(`${session.adapter.id} does not fit ${id}`);
    const name = this.store.probe(id)?.advertisedName ?? null;
    const device: DiscoveredDevice = session.device ?? {
      id,
      name: name ?? 'Unknown',
      advertisedName: name,
      rssi: 0,
      services: [],
      manufacturerData: null,
      serviceData: {},
      adapter: { id: session.adapter.id, name: session.adapter.name },
    };
    this.dropDevice(id);
    this.store.forgetDevice(id);
    this.store.set({ unsupportedDevice: device });
    this.store.stateChanged();
  }

  /** Disconnect and remove the session and cards. */
  private dropDevice(deviceId: string) {
    const session = this.sessions.get(deviceId);
    if (session) {
      this.resetSession(session);
      this.sessions.delete(deviceId);
      this.ble.cancel(deviceId).catch(() => undefined);
    }
    for (const probe of this.store.probes.filter((p) => p.deviceId === deviceId)) {
      this.cancelTargetSync(probe.id);
    }
    this.store.removeDeviceCards(deviceId);
  }

  private handleHostEvent(session: Session, event: HostEvent) {
    const id = session.deviceId;
    switch (event.type) {
      case 'write': {
        const target = session.chars.get(event.char);
        if (!target) {
          this.log(`write: no characteristic ${event.char}`);
          return;
        }
        this.ble
          .write(id, target.service, target.char, event.bytes, event.withResponse)
          .catch((e) => this.log(`write ${event.char}: ${errorText(e)}`));
        return;
      }
      case 'reading': {
        const channel = event.reading.channel;
        const isNewCard = this.store.applyReading(
          id,
          event.reading,
          session.adapter,
          session.channelBattery.get(channel) ?? null,
        );
        if (isNewCard && session.runtime?.status === 'ready') {
          const card = this.store.probes.find((p) => p.deviceId === id && p.channel === channel);
          if (card) this.pushAlarm(card.id);
        }
        this.store.stateChanged();
        return;
      }
      case 'battery':
        if (event.battery.probe !== undefined) {
          session.channelBattery.set(event.battery.channel ?? 0, event.battery.probe);
        }
        this.store.applyBattery(id, event.battery);
        return;
      case 'status': {
        const { status, reason } = event;
        // Keep JS timers alive through the auth retry sequence.
        if (status === 'authenticating') {
          session.releaseAuthWork ??= this.holdBackgroundWork();
        } else {
          session.releaseAuthWork?.();
          session.releaseAuthWork = null;
        }
        const wasReady = this.store.probes.some((p) => p.deviceId === id && p.authState === 'authed');
        this.store.mutateDevice(id, () => ({ authState: AUTH_STATE[status] }));
        if (status === 'ready') this.store.set({ lastError: null });
        if (status === 'failed' && reason !== undefined) this.store.set({ lastError: reason });
        if (status === 'ready' && !wasReady) {
          for (const probe of this.store.probes.filter((p) => p.deviceId === id)) this.pushAlarm(probe.id);
        }
        return;
      }
      case 'exception':
        this.log(`adapter exception: ${event.message}`);
        this.store.set({ lastError: event.message });
        return;
      case 'dropped':
        this.log(`adapter: dropped ${event.why}`);
        return;
      case 'log':
        this.log(`adapter: ${event.message}`);
    }
  }

  // Device alarm. host.ts drops these unless the adapter is ready.

  private runtimeFor(probeIdValue: string) {
    const probe = this.store.probe(probeIdValue);
    const runtime = probe && this.sessions.get(probe.deviceId)?.runtime;
    return probe && runtime ? { probe, runtime } : null;
  }

  private applyTarget(probeIdValue: string) {
    const found = this.runtimeFor(probeIdValue);
    found?.runtime.setTarget(found.probe.channel, alarmTargetF(found.probe));
  }

  private pushBuzzer(probeIdValue: string) {
    const found = this.runtimeFor(probeIdValue);
    found?.runtime.setBuzzer(found.probe.channel, shouldMuteBaseBuzzer(found.probe));
  }

  private pushAlarm(probeIdValue: string) {
    this.cancelTargetSync(probeIdValue);
    this.applyTarget(probeIdValue);
    this.pushBuzzer(probeIdValue);
  }

  private scheduleTargetSync(probeIdValue: string) {
    this.cancelTargetSync(probeIdValue);
    this.targetTimers.set(
      probeIdValue,
      this.clock.schedule(TARGET_DEBOUNCE_MS, () => {
        this.targetTimers.delete(probeIdValue);
        this.applyTarget(probeIdValue);
      }),
    );
  }

  private cancelTargetSync(probeIdValue: string) {
    this.targetTimers.get(probeIdValue)?.();
    this.targetTimers.delete(probeIdValue);
  }

  private updateRestoreHint() {
    const { probes, useCelsius } = this.store.getSnapshot();
    const hint = restoreHint(probes, useCelsius);
    if (hint === this.lastHint) return;
    this.lastHint = hint;
    this.ble.setRestoreHint(hint).catch(() => undefined);
  }

  private fail(error: unknown) {
    this.log(errorText(error));
    this.store.set({ lastError: errorText(error) });
  }
}
