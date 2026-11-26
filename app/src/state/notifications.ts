import type { TargetAlert } from './alarms';

export const targetNotificationId = (probeId: string) => `bbqlaw.target.${probeId}`;

/** Implemented by `expoNotifier.ts` in the app. */
export interface Notifier {
  fire(alert: TargetAlert): void;
  /** Removes the pending and the delivered target alert for a probe. */
  cancel(probeId: string): void;
}
