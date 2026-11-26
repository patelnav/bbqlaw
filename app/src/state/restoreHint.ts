// The text of the cold-relaunch notification (spec §4.3).
import { alarmTargetF, type Probe } from './probe';
import { formatTemp, tempUnit } from './temperature';

/** Empty when there is nothing to watch; the native side then uses its default. */
export function restoreHint(probes: Probe[], celsius: boolean): string {
  if (probes.length === 0) return '';
  const names = probes.map((p) => p.name).join(', ');
  const targets = [
    ...new Set(
      probes.flatMap((p) => {
        const t = alarmTargetF(p);
        return t === null ? [] : [`${formatTemp(t, celsius)}${tempUnit(celsius)}`];
      }),
    ),
  ];
  return targets.length === 0 ? `Watching ${names}` : `Watching ${names} · target ${targets.join(' / ')}`;
}
