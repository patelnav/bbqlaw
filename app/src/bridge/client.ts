// Agent link: pairing and BLE-driven pushes. The relay API is the 1.0 API.
import type { HoldBackgroundWork } from '../engine/backgroundWork';
import type { Fetch } from '../engine/upload';
import { alarmTargetF, colorString, isReached, meatForKey, type Probe } from '../state/probe';
import type { ProbeStore } from '../state/store';
import type { CredentialStore, Credentials } from './credentials';

export const RELAY_BASE = 'https://bbqlaw.app';
const PUSH_INTERVAL_MS = 20_000;
const TIMEOUT_MS = 20_000;

type PushKind = 'heartbeat' | 'target' | 'disconnect';

export interface BridgeSnapshot {
  isLinked: boolean;
  shareURL: string | null;
  linking: boolean;
  lastError: string | null;
  lastPushError: string | null;
}

export const feedURL = (readerToken: string) => `${RELAY_BASE}/openclaw/${readerToken}`;

export function probePayload(p: Probe) {
  const connected = p.connection === 'connected';
  // Absent values are omitted, as the 1.0 encoder did.
  return {
    id: p.id,
    name: p.name,
    color: colorString(p.colorHex),
    tempF: connected ? (p.tempF ?? undefined) : undefined,
    targetF: alarmTargetF(p) ?? undefined,
    meat: meatForKey(p.meatKey)?.name,
    doneness: p.doneness ?? undefined,
    mode: p.mode,
    probeBattery: p.probeBattery ?? undefined,
    baseBattery: p.baseBattery ?? undefined,
    connected,
  };
}

export class BridgeClient {
  private credentials: Credentials | null = null;
  private snapshot: BridgeSnapshot = {
    isLinked: false, shareURL: null, linking: false, lastError: null, lastPushError: null,
  };
  private listeners = new Set<() => void>();
  private reached = new Set<string>();
  private targetPushInFlight = false;
  private wasAnyConnected = false;
  private lastAttemptAt: number | null = null;
  private failures = 0;

  constructor(
    private store: ProbeStore,
    private credentialStore: CredentialStore,
    private holdBackgroundWork: HoldBackgroundWork,
    private fetcher: Fetch = (...args) => fetch(...args),
    private now: () => number = Date.now,
  ) {
    store.onStateChange(() => void this.onStoreUpdate());
  }

  getSnapshot = (): BridgeSnapshot => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Reads the saved link. Safe to call again (for example after the first unlock). */
  async refresh() {
    this.apply(await this.credentialStore.load());
  }

  async unlink() {
    await this.credentialStore.clear();
    this.apply(null);
    this.set({ lastError: null, lastPushError: null });
  }

  /** Pair with the relay. Returns the feed link, or null on failure. */
  async pair(): Promise<string | null> {
    if (this.snapshot.linking) return null;
    this.set({ linking: true, lastError: null });
    try {
      const response = await this.request(`${RELAY_BASE}/api/pair`, {}, '{}');
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (!response.ok) {
        throw new Error(typeof body?.error === 'string' ? body.error : `Pair failed (HTTP ${response.status}).`);
      }
      const { device, deviceToken, readerToken, ingestUrl } = body ?? {};
      if (typeof device !== 'string' || typeof deviceToken !== 'string' || typeof readerToken !== 'string') {
        throw new Error('Unexpected response.');
      }
      if (typeof ingestUrl !== 'string' || !ingestUrl.startsWith('https://')) {
        throw new Error('Invalid ingest URL from relay.');
      }
      const credentials = { deviceId: device, deviceToken, ingestURL: ingestUrl, readerToken };
      if (!(await this.credentialStore.save(credentials))) throw new Error('Could not save credentials to Keychain.');
      this.apply(credentials);
      return feedURL(readerToken);
    } catch (error) {
      this.set({ lastError: error instanceof Error ? error.message : String(error) });
      return null;
    } finally {
      this.set({ linking: false });
    }
  }

  private apply(credentials: Credentials | null) {
    this.credentials = credentials;
    this.set({
      isLinked: credentials !== null,
      shareURL: credentials?.readerToken ? feedURL(credentials.readerToken) : null,
    });
  }

  private get interval() {
    return PUSH_INTERVAL_MS * (1 + Math.min(this.failures, 5)) - 1000;
  }

  /**
   * Throttled to about every 20 s; at once when a probe newly reaches target; one
   * final push when all probes disconnect.
   */
  private onStoreUpdate(): Promise<void> | undefined {
    if (!this.credentials) return;
    const probes = this.store.probes;
    if (!probes.some((p) => p.connection === 'connected')) {
      if (!this.wasAnyConnected) return;
      this.wasAnyConnected = false;
      this.reached.clear();
      this.targetPushInFlight = false;
      return this.push('disconnect');
    }
    this.wasAnyConnected = true;

    const newlyReached = probes.find((p) => isReached(p) && !this.reached.has(p.id));
    if (newlyReached && !this.targetPushInFlight) {
      this.targetPushInFlight = true;
      return this.push('target', newlyReached.id);
    }
    if (this.targetPushInFlight) return;
    for (const p of probes) if (!isReached(p)) this.reached.delete(p.id);

    if (this.lastAttemptAt !== null && this.now() - this.lastAttemptAt < this.interval) return;
    return this.push('heartbeat');
  }

  private async push(kind: PushKind, markReached?: string) {
    const credentials = this.credentials;
    if (!credentials) return;
    this.lastAttemptAt = this.now();
    const body = JSON.stringify({
      device: credentials.deviceId,
      ts: Math.floor(this.now() / 1000),
      probes: this.store.probes.map(probePayload),
    });
    const release = this.holdBackgroundWork();
    try {
      const response = await this.request(
        credentials.ingestURL,
        { Authorization: `Bearer ${credentials.deviceToken}` },
        body,
      );
      if (!response.ok) throw new Error(`Push failed (HTTP ${response.status}).`);
      this.failures = 0;
      this.set({ lastPushError: null });
      if (kind === 'target' && markReached !== undefined) this.reached.add(markReached);
    } catch (error) {
      this.failures += 1;
      console.warn('bridge push failed:', error);
      this.set({ lastPushError: error instanceof Error ? error.message : String(error) });
    } finally {
      if (kind === 'target') this.targetPushInFlight = false;
      release();
    }
  }

  private async request(url: string, headers: Record<string, string>, body: string) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
    try {
      return await this.fetcher(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
        signal: abort.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private set(patch: Partial<BridgeSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}
