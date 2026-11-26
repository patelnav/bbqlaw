export const fahrenheitToCelsius = (f: number) => ((f - 32) * 5) / 9;

export function formatTemp(f: number | null, celsius: boolean): string {
  if (f === null) return '—';
  return String(Math.round(celsius ? fahrenheitToCelsius(f) : f));
}

export const tempUnit = (celsius: boolean) => (celsius ? '°C' : '°F');

export function toGo(tempF: number, targetF: number, celsius: boolean): number {
  const diff = celsius ? fahrenheitToCelsius(targetF) - fahrenheitToCelsius(tempF) : targetF - tempF;
  return Math.max(0, Math.round(diff));
}

export function relativeAge(sinceMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - sinceMs) / 1000));
  if (s < 2) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}
