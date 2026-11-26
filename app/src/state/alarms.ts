// Target alarm with hysteresis: it re-arms only below target − 2 °F.
import { alarmTargetF, type Probe } from './probe';

export const REARM_BELOW_F = 2;

export interface TargetAlert {
  probeId: string;
  title: string;
  body: string;
}

export function evaluateAlarm(p: Probe): { probe: Probe; alert: TargetAlert | null } {
  const target = alarmTargetF(p);
  if (target === null || p.tempF === null || p.mode !== 'live') return { probe: p, alert: null };
  if (p.tempF >= target) {
    const alert = p.hasFiredAlarm
      ? null
      : {
          probeId: p.id,
          title: `🔥 ${p.name} hit target`,
          body: `${p.name} reached ${p.tempF.toFixed(0)}°F (target ${target.toFixed(0)}°F).`,
        };
    return { probe: { ...p, targetReached: true, hasFiredAlarm: true }, alert };
  }
  if (p.tempF < target - REARM_BELOW_F) {
    return { probe: { ...p, targetReached: false, hasFiredAlarm: false }, alert: null };
  }
  return { probe: p, alert: null };
}
