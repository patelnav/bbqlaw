// Devices that no protocol could read (spec §6.7). The scan sheet offers a retry
// after a new update. There are no background trials.
import type { KeyValueStorage } from './persistence';

export const PENDING_KEY = 'bbqlaw.pending.v1';

export interface PendingDevice {
  deviceId: string;
  fingerprint: string;
  updateId: string;
}

export function parsePending(text: string | null): Record<string, PendingDevice> {
  const out: Record<string, PendingDevice> = {};
  let data: unknown;
  try {
    data = JSON.parse(text ?? '[]');
  } catch {
    return out;
  }
  if (!Array.isArray(data)) return out;
  for (const item of data as Partial<PendingDevice>[]) {
    if (typeof item?.deviceId !== 'string' || typeof item.fingerprint !== 'string' || typeof item.updateId !== 'string') {
      continue;
    }
    out[item.deviceId] = { deviceId: item.deviceId, fingerprint: item.fingerprint, updateId: item.updateId };
  }
  return out;
}

export class PendingDevices {
  private devices: Record<string, PendingDevice> = {};

  constructor(
    private storage: KeyValueStorage,
    /** The running update id, or "embedded". */
    private updateId: string,
  ) {}

  async load() {
    this.devices = parsePending(await this.storage.getItem(PENDING_KEY));
  }

  add(deviceId: string, fingerprint: string): Promise<void> {
    this.devices[deviceId] = { deviceId, fingerprint, updateId: this.updateId };
    return this.save();
  }

  remove(deviceId: string): Promise<void> {
    if (!this.devices[deviceId]) return Promise.resolve();
    delete this.devices[deviceId];
    return this.save();
  }

  /** True when this device failed on a different update than the one running. */
  hasNewSupport = (deviceId: string): boolean => {
    const device = this.devices[deviceId];
    return device !== undefined && device.updateId !== this.updateId;
  };

  private save() {
    return this.storage
      .setItem(PENDING_KEY, JSON.stringify(Object.values(this.devices)))
      .catch((e) => console.warn('storage:', e));
  }
}
