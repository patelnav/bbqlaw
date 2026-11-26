import * as Haptics from 'expo-haptics';
import * as Notifications from 'expo-notifications';
import { targetNotificationId, type Notifier } from './notifications';

/** Show target alerts (with sound) while the app is in the foreground too. */
export function setUpNotifications() {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

export const requestNotificationPermission = () =>
  Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true } }).catch(() => undefined);

const logFailure = (error: unknown) => console.warn('notification:', error);

export const expoNotifier: Notifier = {
  fire(alert) {
    Notifications.scheduleNotificationAsync({
      identifier: targetNotificationId(alert.probeId),
      content: { title: alert.title, body: alert.body, sound: 'default' },
      trigger: null,
    }).catch(logFailure);
    // Haptic on the rising edge (no-op in the background).
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
  },
  cancel(probeId) {
    const id = targetNotificationId(probeId);
    Notifications.cancelScheduledNotificationAsync(id).catch(logFailure);
    Notifications.dismissNotificationAsync(id).catch(logFailure);
  },
};
