// What the status pill says.
import type { Probe } from '../state/probe';

export interface PillStatus {
  label: string;
  tone: 'live' | 'idle' | 'danger';
  pulse: boolean;
}

const pill = (label: string, tone: PillStatus['tone'], pulse = false): PillStatus => ({ label, tone, pulse });

export function statusPill(bluetoothOff: boolean, probes: Probe[], active: Probe | undefined): PillStatus {
  if (bluetoothOff) return pill('Bluetooth off', 'danger');
  if (!active) return pill('Ready', 'idle');
  const auth =
    active.authState === 'subscribing' || active.authState === 'requested'
      ? pill('Authenticating…', 'idle', true)
      : active.authState === 'waiting'
        ? pill('Waiting for probe…', 'idle', true)
        : active.authState === 'failed'
          ? pill('Authentication failed', 'danger')
          : null;
  if (active.connection === 'connecting') return pill('Connecting…', 'idle', true);
  if (active.connection === 'disconnected') return pill('Disconnected', 'idle', true);
  if (auth) return auth;
  const count = probes.filter((p) => p.connection === 'connected').length;
  return pill(count > 1 ? `${count} probes · Connected` : 'Connected', 'live');
}
