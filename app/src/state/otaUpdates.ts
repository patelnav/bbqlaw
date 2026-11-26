// Spec §8: check on foreground, fetch in the background, apply on the next cold
// start. Never reload during a cook.
import * as Updates from 'expo-updates';
import { AppState } from 'react-native';

export function watchForUpdates() {
  if (__DEV__ || !Updates.isEnabled) return;
  let running = false;
  const check = async () => {
    if (running) return;
    running = true;
    try {
      if ((await Updates.checkForUpdateAsync()).isAvailable) await Updates.fetchUpdateAsync();
    } catch (error) {
      console.log('update check:', error);
    } finally {
      running = false;
    }
  };
  AppState.addEventListener('change', (state) => {
    if (state === 'active') void check();
  });
  void check();
}

export function updateLabel(): string {
  if (!Updates.updateId || Updates.isEmbeddedLaunch) return 'Update embedded';
  const date = Updates.createdAt ? ` · ${Updates.createdAt.toISOString().slice(0, 10)}` : '';
  return `Update ${Updates.updateId.slice(0, 8)}${date}`;
}
