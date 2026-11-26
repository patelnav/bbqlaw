// Identify an unknown thermometer (spec §6). Nothing connects or writes until
// `start()`, which the UI calls only from the "Try protocols" tap. Trials run the
// real host and adapters, so a write reaches only an adapter's own characteristics.
import { resolveChars, routeValue, startAdapterSession, type ResolvedChar } from './adapterSession';
import type { BleEvents, BleTransport, DiscoveredService } from './ble';
import { fingerprintString, type Sha256 } from './fingerprint';
import { systemClock, type AdapterRuntime, type Clock, type HostEvent } from './host';
import {
  DOCKED_EXTRA_MS, TRIAL_MS, candidates, emptyScore, isDockedPass, isLivePass, scoreReading, type Score,
} from './scoring';
import type { AdapterDef } from './types';

const CONNECT_TIMEOUT_MS = 15_000;
const DISCONNECT_WAIT_MS = 2_000;
const READINGS_PER_ATTEMPT = 50; // our limit, so a capture stays small

export interface IdentifyAttempt {
  adapterId: string;
  result: 'fail' | 'livePass' | 'dockedPass' | 'rejectedByUser';
  reason: string;
  readings: { t: number; state: string; foodF?: number | null }[];
}

export interface IdentifySnapshot {
  phase: 'intro' | 'connecting' | 'trying' | 'docked' | 'confirm' | 'matched' | 'noMatch' | 'error' | 'cancelled';
  adapter: { id: string; name: string } | null;
  trial: number;
  trials: number;
  /** The live temperature to confirm. */
  readingF: number | null;
  error: string | null;
}

export interface IdentifyDeps {
  ble: BleTransport;
  deviceId: string;
  advertisedName: string | null;
  manufacturerData: string | null;
  adapters: readonly AdapterDef[];
  fingerprints: Readonly<Record<string, string>>;
  sha256: Sha256;
  claim: (deviceId: string) => () => void;
  /** No protocol matched: remember the device for "New support — tap to retry". */
  onNoMatch: (fingerprint: string) => void;
  clock?: Clock;
  log?: (message: string) => void;
}

type Outcome = { kind: 'livePass' } | { kind: 'failed' | 'dockedOnly'; reason: string } | { kind: 'cancelled' };

class Cancelled extends Error {}

export class IdentifySession {
  /** Every finished trial. A capture includes them. */
  readonly attempts: IdentifyAttempt[] = [];
  private snapshot: IdentifySnapshot = {
    phase: 'intro', adapter: null, trial: 0, trials: 0, readingF: null, error: null,
  };
  private listeners = new Set<() => void>();
  private clock: Clock;
  private release: (() => void) | null = null;
  private connected = false;
  private cancelled = false;
  private answer: ((yes: boolean) => void) | null = null;
  /** Ends whatever the run is waiting for. */
  private interrupt: ((reason: string) => void) | null = null;
  private finished: Promise<void> = Promise.resolve();
  private pendingMatch: { id: string; name: string } | null = null;
  private unwatch: (() => void) | null = null;

  constructor(private deps: IdentifyDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  getSnapshot = (): IdentifySnapshot => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** "Try protocols". */
  start() {
    if (this.snapshot.phase !== 'intro' && this.snapshot.phase !== 'error') return;
    this.cancelled = false;
    this.attempts.length = 0;
    this.set({ phase: 'connecting', error: null });
    this.release = this.deps.claim(this.deps.deviceId);
    this.finished = this.run().catch((error) => {
      if (!(error instanceof Cancelled)) {
        this.set({ phase: 'error', error: error instanceof Error ? error.message : String(error) });
      }
    });
    this.finished = this.finished.then(() => this.cleanUp());
  }

  /** The answer to "Does that match the thermometer's screen?" */
  confirm(yes: boolean) {
    this.answer?.(yes);
  }

  /** Closes the session. Resolves when the device is disconnected and released. */
  cancel(): Promise<void> {
    if (this.snapshot.phase !== 'matched') {
      this.cancelled = true;
      this.interrupt?.('cancelled');
      this.set({ phase: 'cancelled' });
      // Drop the link now: this also ends a discovery that is still pending.
      if (this.release) void this.deps.ble.cancel(this.deps.deviceId).catch(() => undefined);
    }
    return this.finished;
  }

  private async cleanUp() {
    await this.disconnect();
    this.release?.();
    this.release = null;
    // The match is announced only now, so a normal connection cannot collide with ours.
    if (this.pendingMatch && !this.cancelled) this.set({ phase: 'matched', adapter: this.pendingMatch });
    this.pendingMatch = null;
  }

  private async run() {
    const { deps } = this;
    let services = await this.connectAndDiscover();
    const fingerprint = fingerprintString(services, deps.advertisedName, deps.manufacturerData);
    const hit = deps.fingerprints[await deps.sha256(fingerprint)] ?? null;
    this.checkCancelled();
    const list = candidates(deps.adapters, services, hit);

    for (const [index, adapter] of list.entries()) {
      if (index > 0) {
        await this.disconnect();
        services = await this.connectAndDiscover();
      }
      this.set({
        phase: 'trying', adapter: { id: adapter.id, name: adapter.name },
        trial: index + 1, trials: list.length, readingF: null,
      });
      if (await this.trial(adapter, services)) {
        this.pendingMatch = { id: adapter.id, name: adapter.name };
        return;
      }
    }
    deps.onNoMatch(fingerprint);
    this.set({ phase: 'noMatch', adapter: null, readingF: null });
  }

  /** True when the user confirmed the reading. */
  private async trial(adapter: AdapterDef, services: DiscoveredService[]): Promise<boolean> {
    const attempt: IdentifyAttempt = { adapterId: adapter.id, result: 'fail', reason: '', readings: [] };
    const chars: Map<string, ResolvedChar> = resolveChars(adapter, services);
    let runtime: AdapterRuntime | null = null;
    let score: Score = emptyScore;
    let active = true;
    let startedAt = this.clock.now();
    let cancelTimer: () => void = () => {};
    let unsubscribe: (() => void) | null = null;

    let settle!: (outcome: Outcome) => void;
    const outcome = new Promise<Outcome>((resolve) => (settle = resolve));
    const fail = (reason: string) => {
      if (this.snapshot.phase === 'docked') settle({ kind: 'dockedOnly', reason });
      else settle({ kind: 'failed', reason });
    };
    const arm = (ms: number, reason: () => string) => {
      cancelTimer();
      cancelTimer = this.clock.schedule(ms, () => fail(reason()));
    };
    // Why the trial ended while the user was deciding.
    let lost = '';
    const stop = (reason: string) => {
      if (reason === 'cancelled') settle({ kind: 'cancelled' });
      else fail(reason);
      if (this.answer) {
        lost = reason;
        this.answer(false);
      }
    };
    this.interrupt = stop;

    let decided = false;
    const evaluate = () => {
      if (isLivePass(score)) {
        if (!decided) {
          decided = true;
          cancelTimer();
          settle({ kind: 'livePass' });
        }
        this.set({ readingF: score.latestF });
      } else if (!decided && isDockedPass(score) && this.snapshot.phase === 'trying') {
        this.set({ phase: 'docked' });
        arm(DOCKED_EXTRA_MS, () => 'no live reading after docked');
      }
    };

    const onEvent = (event: HostEvent) => {
      if (event.type === 'exception') stop(`adapter exception: ${event.message}`);
      else if (event.type === 'status') {
        if (event.status === 'failed') stop(event.reason ?? 'adapter failed');
        else if (event.status === 'ready') {
          score = { ...score, ready: true };
          evaluate();
        }
      } else if (event.type === 'reading') {
        const { state, foodF } = event.reading;
        if (attempt.readings.length < READINGS_PER_ATTEMPT) {
          attempt.readings.push({ t: Math.round(this.clock.now() - startedAt), state, ...(foodF !== undefined ? { foodF } : {}) });
        }
        const next = scoreReading(score, event.reading);
        if (next === 'failed') {
          stop('reading out of range');
          return;
        }
        score = next;
        evaluate();
      } else if (event.type === 'log') this.deps.log?.(`${adapter.id}: ${event.message}`);
    };

    try {
      unsubscribe = this.deps.ble.on('value', (e) => {
        if (e.id === this.deps.deviceId && runtime && active) routeValue(runtime, chars, e.service, e.char, e.bytes);
      });
      startAdapterSession({
        ble: this.deps.ble,
        deviceId: this.deps.deviceId,
        adapter,
        services,
        chars,
        clock: this.clock,
        current: () => active,
        onEvent,
        onRuntime: (created) => (runtime = created),
        // The 30 s trial clock starts after onReady().
        onStarted: () => {
          startedAt = this.clock.now();
          if (!decided && this.snapshot.phase === 'trying') {
            arm(TRIAL_MS, () => (score.ready ? 'no steady live reading' : 'not ready'));
          }
        },
        log: (m) => this.deps.log?.(m),
      }).catch((error) => fail(`adapter exception: ${error instanceof Error ? error.message : String(error)}`));
      // A subscription that never answers must not stop the trial.
      arm(TRIAL_MS + CONNECT_TIMEOUT_MS, () => 'not ready');

      const result = await outcome;
      if (result.kind === 'cancelled') throw new Cancelled();
      if (result.kind !== 'livePass') {
        attempt.result = result.kind === 'dockedOnly' ? 'dockedPass' : 'fail';
        attempt.reason = result.reason;
        this.attempts.push(attempt);
        return false;
      }

      // Ask the user. A bad reading or a lost connection ends the question.
      if (!this.connected) lost = 'disconnected';
      const answered = new Promise<boolean>((resolve) => {
        if (lost) resolve(false);
        else this.answer = resolve;
      });
      if (!lost) this.set({ phase: 'confirm', readingF: score.latestF });
      const yes = await answered;
      this.answer = null;
      this.checkCancelled();
      attempt.result = yes ? 'livePass' : lost ? 'fail' : 'rejectedByUser';
      attempt.reason = yes ? 'confirmed by user' : lost || 'user said the reading does not match';
      this.attempts.push(attempt);
      return yes;
    } finally {
      active = false;
      cancelTimer();
      unsubscribe?.();
      (runtime as AdapterRuntime | null)?.invalidate();
      this.interrupt = null;
      this.answer = null;
    }
  }

  private async connectAndDiscover(): Promise<DiscoveredService[]> {
    this.checkCancelled();
    const { ble, deviceId } = this.deps;
    await this.waitFor(CONNECT_TIMEOUT_MS, 'Could not connect to the thermometer.', (done, fail) => {
      const offs = [
        ble.on('connected', (e) => e.id === deviceId && done()),
        ble.on('failedToConnect', (e) => e.id === deviceId && fail(e.error)),
      ];
      ble.connect(deviceId).catch((e) => fail(e instanceof Error ? e.message : String(e)));
      return () => offs.forEach((off) => off());
    });
    this.connected = true;
    this.watchConnection();
    const services = await ble.discover(deviceId);
    this.checkCancelled();
    return services;
  }

  private watchConnection() {
    this.unwatch?.();
    const lost = () => {
      this.connected = false;
      this.interrupt?.('disconnected');
    };
    const offs = [
      this.deps.ble.on('disconnected', (e) => e.id === this.deps.deviceId && lost()),
      this.deps.ble.on('state', (e: BleEvents['state']) => e.state !== 'poweredOn' && lost()),
    ];
    this.unwatch = () => offs.forEach((off) => off());
  }

  /** Cancels the connection and waits for the radio to report it. */
  private async disconnect() {
    this.unwatch?.();
    this.unwatch = null;
    const { ble, deviceId } = this.deps;
    const wasConnected = this.connected;
    this.connected = false;
    if (!wasConnected) {
      await ble.cancel(deviceId).catch(() => undefined);
      return;
    }
    await new Promise<void>((resolve) => {
      const finish = () => {
        off();
        stopTimer();
        resolve();
      };
      const off = ble.on('disconnected', (e) => e.id === deviceId && finish());
      const stopTimer = this.clock.schedule(DISCONNECT_WAIT_MS, finish);
      ble.cancel(deviceId).catch(finish);
    });
  }

  /** Waits for a radio callback, with a timeout and cancellation. */
  private waitFor(
    ms: number,
    timeoutMessage: string,
    begin: (done: () => void, fail: (message: string) => void) => () => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let cleanUp: () => void = () => {};
      let over = false;
      const end = (error?: Error) => {
        if (over) return;
        over = true;
        stopTimer();
        cleanUp();
        this.interrupt = null;
        if (error) reject(error);
        else resolve();
      };
      const stopTimer = this.clock.schedule(ms, () => end(new Error(timeoutMessage)));
      this.interrupt = () => end(new Cancelled());
      cleanUp = begin(
        () => end(),
        (message) => end(new Error(message)),
      );
    });
  }

  private checkCancelled() {
    if (this.cancelled) throw new Cancelled();
  }

  private set(patch: Partial<IdentifySnapshot>) {
    if (this.cancelled && patch.phase !== 'cancelled') return;
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}
