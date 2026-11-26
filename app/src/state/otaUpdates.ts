// Spec §8: check on foreground, fetch in the background, apply on the next cold
// start. Never reload during a cook. The app never reloads on its own: only the
// user's tap on "Restart to finish update" in Settings calls restartToUpdate().
import * as Updates from 'expo-updates';
import { AppState } from 'react-native';

// One check at a time. A caller that arrives during a check shares its result.
let inflight: Promise<LibraryUpdateResult> | null = null;

export type LibraryUpdateResult = 'up-to-date' | 'ready' | 'off' | 'failed';

export interface UpdatesPort {
  enabled: boolean;
  check: () => Promise<{ isAvailable: boolean }>;
  fetch: () => Promise<unknown>;
}

// `alreadyPending` comes from the expo-updates state (useUpdates().isUpdatePending).
export async function updateLibraryWith(port: UpdatesPort, alreadyPending = false): Promise<LibraryUpdateResult> {
  if (!port.enabled) return 'off';
  if (inflight) return inflight;
  inflight = (async (): Promise<LibraryUpdateResult> => {
    try {
      if ((await port.check()).isAvailable) {
        await port.fetch();
        return 'ready';
      }
      return alreadyPending ? 'ready' : 'up-to-date';
    } catch (error) {
      console.log('update library:', error);
      return 'failed';
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

const realPort = (): UpdatesPort => ({
  enabled: !__DEV__ && Updates.isEnabled,
  check: () => Updates.checkForUpdateAsync(),
  fetch: () => Updates.fetchUpdateAsync(),
});

export function updateLibraryNow(alreadyPending = false): Promise<LibraryUpdateResult> {
  return updateLibraryWith(realPort(), alreadyPending);
}

export async function restartToUpdate(): Promise<void> {
  await Updates.reloadAsync();
}

export function watchForUpdates() {
  if (__DEV__ || !Updates.isEnabled) return;
  const check = () => void updateLibraryWith(realPort());
  AppState.addEventListener('change', (state) => {
    if (state === 'active') check();
  });
  check();
}

export function updateLabel(): string {
  if (!Updates.updateId || Updates.isEmbeddedLaunch) return 'Update embedded';
  const date = Updates.createdAt ? ` · ${Updates.createdAt.toISOString().slice(0, 10)}` : '';
  return `Update ${Updates.updateId.slice(0, 8)}${date}`;
}
