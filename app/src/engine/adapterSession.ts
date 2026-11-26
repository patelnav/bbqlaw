// Runs one adapter on a connected, discovered peripheral: resolve its
// characteristics, subscribe, `onReady`, then the initial reads. Used by normal
// sessions and by identify trials.
import type { BleTransport, CharProp, DiscoveredService } from './ble';
import { createRuntime, type AdapterRuntime, type Clock, type HostEvent } from './host';
import type { AdapterDef } from './types';
import { canonicalUUID, parseGattRef } from './uuid';

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

/** Every characteristic of the adapter that this peripheral has, by canonical UUID. */
export function resolveChars(adapter: AdapterDef, services: DiscoveredService[]): Map<string, ResolvedChar> {
  const { notify, read, write } = adapter.gatt;
  const chars = new Map<string, ResolvedChar>();
  for (const entry of [...notify, ...read, ...write]) {
    const resolved = resolveGatt(adapter, services, entry);
    if (resolved) chars.set(resolved.char, resolved);
  }
  return chars;
}

export interface AdapterSessionOptions {
  ble: BleTransport;
  deviceId: string;
  adapter: AdapterDef;
  services: DiscoveredService[];
  chars: Map<string, ResolvedChar>;
  clock: Clock;
  /** False after a disconnect or reset: late work then does nothing. */
  current: () => boolean;
  onEvent: (event: HostEvent) => void;
  /** Called with the runtime before any subscription, so values can be routed to it. */
  onRuntime: (runtime: AdapterRuntime) => void;
  /** Called right after `onReady()`. */
  onStarted?: () => void;
  onSubscribeError?: (message: string) => void;
  log: (message: string) => void;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Routes host events: writes go to the radio, the rest to `onEvent`. */
export async function startAdapterSession(o: AdapterSessionOptions): Promise<void> {
  const { ble, deviceId, adapter, services, chars, current } = o;
  const runtime = createRuntime(
    adapter,
    (event) => {
      if (!current()) return;
      if (event.type !== 'write') {
        o.onEvent(event);
        return;
      }
      const target = chars.get(event.char);
      if (!target) {
        o.log(`write: no characteristic ${event.char}`);
        return;
      }
      ble
        .write(deviceId, target.service, target.char, event.bytes, event.withResponse)
        .catch((e) => o.log(`write ${event.char}: ${errorText(e)}`));
    },
    o.clock,
  );
  o.onRuntime(runtime);

  // Subscribe every notify characteristic BEFORE onReady: some devices only
  // start their handshake once all of them are subscribed.
  const subscriptions = new Map<string, ResolvedChar>();
  for (const entry of adapter.gatt.notify) {
    const resolved = resolveGatt(adapter, services, entry);
    if (resolved && (resolved.props.includes('notify') || resolved.props.includes('indicate'))) {
      subscriptions.set(`${resolved.service}/${resolved.char}`, resolved);
    } else {
      o.log(`no notify characteristic ${entry}; skipped`);
    }
  }
  await Promise.all(
    [...subscriptions.values()].map((c) =>
      ble.setNotify(deviceId, c.service, c.char, true).catch((error) => {
        o.log(`subscribe ${c.char}: ${errorText(error)}`);
        if (current()) o.onSubscribeError?.(errorText(error));
      }),
    ),
  );
  if (!current()) return;
  runtime.ready();
  o.onStarted?.();

  for (const entry of adapter.gatt.read) {
    const resolved = resolveGatt(adapter, services, entry);
    if (!resolved || !resolved.props.includes('read')) continue;
    try {
      const bytes = await ble.read(deviceId, resolved.service, resolved.char);
      if (!current()) return;
      runtime.notify(resolved.char, bytes);
    } catch (error) {
      o.log(`read ${resolved.char}: ${errorText(error)}`);
    }
  }
}

/** Passes a `value` event to the runtime, unless the UUID belongs to another service. */
export function routeValue(
  runtime: AdapterRuntime,
  chars: Map<string, ResolvedChar>,
  service: string,
  char: string,
  bytes: number[],
) {
  const uuid = canonicalUUID(char);
  if (uuid === null) return;
  const resolved = chars.get(uuid);
  if (resolved && resolved.service !== service) return;
  runtime.notify(uuid, bytes);
}
