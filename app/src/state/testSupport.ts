// In-memory implementations of the two OS services the store uses.
import type { TargetAlert } from './alarms';
import type { Notifier } from './notifications';
import type { KeyValueStorage } from './persistence';

export function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const storage: KeyValueStorage = {
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      data.set(key, value);
    },
  };
  return { storage, data };
}

export function recordingNotifier() {
  const fired: TargetAlert[] = [];
  const cancelled: string[] = [];
  const notifier: Notifier = {
    fire: (alert) => fired.push(alert),
    cancel: (id) => cancelled.push(id),
  };
  return { notifier, fired, cancelled };
}
