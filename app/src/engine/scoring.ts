// Candidate selection and trial scoring (spec §6.3 and §6.4). Pure functions.
import type { DiscoveredService } from './ble';
import type { RecordedReading } from './host';
import type { AdapterDef } from './types';
import { canonicalUUID } from './uuid';

export const TRIAL_MS = 30_000;
export const DOCKED_EXTRA_MS = 30_000;
export const MIN_F = -40;
export const MAX_F = 750;
export const MAX_STEP_F = 15;

/** Adapters that are safe to try and whose signature this peripheral has. */
export function candidates(
  adapters: readonly AdapterDef[],
  services: DiscoveredService[],
  fingerprintHit: string | null,
): AdapterDef[] {
  const fits = (a: AdapterDef) =>
    services.some((s) => {
      if (canonicalUUID(s.service) !== canonicalUUID(a.signature.service)) return false;
      const present = new Set(s.chars.map((c) => canonicalUUID(c.uuid)));
      return a.signature.chars.every((c) => present.has(canonicalUUID(c)));
    });
  // Fingerprint hit, then verified, then the larger signature (then id, to be stable).
  return adapters
    .filter((a) => a.trialSafe && fits(a))
    .sort(
      (a, b) =>
        Number(b.id === fingerprintHit) - Number(a.id === fingerprintHit) ||
        Number(b.verified) - Number(a.verified) ||
        b.signature.chars.length - a.signature.chars.length ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}

export interface Score {
  ready: boolean;
  docked: boolean;
  /** Two live readings of one channel, less than 15 °F apart. */
  steady: boolean;
  /** The channel that passed, and its latest live temperature. */
  channel: number | null;
  latestF: number | null;
  lastLive: Readonly<Record<number, number>>;
}

export const emptyScore: Score = {
  ready: false, docked: false, steady: false, channel: null, latestF: null, lastLive: {},
};

const inRange = (f: number | null | undefined) => typeof f !== 'number' || (f >= MIN_F && f <= MAX_F);

/** Returns the new score, or `failed` for a reading outside −40…750 °F. */
export function scoreReading(score: Score, reading: RecordedReading): Score | 'failed' {
  if (!inRange(reading.foodF) || !inRange(reading.ambientF)) return 'failed';
  if (reading.state === 'docked') return { ...score, docked: true };
  if (reading.state !== 'live' || typeof reading.foodF !== 'number') return score;
  const previous = score.lastLive[reading.channel];
  const steadyNow = previous !== undefined && Math.abs(reading.foodF - previous) < MAX_STEP_F;
  const channel = score.channel ?? (steadyNow ? reading.channel : null);
  return {
    ...score,
    lastLive: { ...score.lastLive, [reading.channel]: reading.foodF },
    steady: score.steady || steadyNow,
    channel,
    latestF: channel === reading.channel ? reading.foodF : score.latestF,
  };
}

export const isLivePass = (s: Score) => s.ready && s.steady;
export const isDockedPass = (s: Score) => s.ready && s.docked;
