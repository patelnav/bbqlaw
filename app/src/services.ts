// Wires the engine to the native modules. One instance per JS runtime.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Application from 'expo-application';
import { CryptoDigestAlgorithm, digestStringAsync } from 'expo-crypto';
import * as Updates from 'expo-updates';
import { AppState, Platform } from 'react-native';
import { ADAPTERS } from './adapters';
import { BridgeClient } from './bridge/client';
import type { CredentialStore } from './bridge/credentials';
import { createBackgroundWork } from './engine/backgroundWork';
import type { BleTransport } from './engine/ble';
import { CaptureSession, type CaptureAdvertisement, type CaptureDocument } from './engine/capture';
import { shareCaptureFile, writeCaptureFile } from './engine/captureFile';
import { SessionManager } from './engine/sessionManager';
import { uploadCapture } from './engine/upload';
import { expoNotifier } from './state/expoNotifier';
import { updateLabel } from './state/otaUpdates';
import type { KeyValueStorage } from './state/persistence';
import { ProbeStore } from './state/store';

/** The OS boundaries. The __DEV__ demo supplies its own. */
export interface Platforms {
  ble: BleTransport;
  storage?: KeyValueStorage;
  credentials: CredentialStore;
  upload?: (document: CaptureDocument) => Promise<string>;
}

export function createServices(platforms: Platforms) {
  const { ble, credentials } = platforms;
  const store = new ProbeStore(platforms.storage ?? AsyncStorage, expoNotifier);
  const holdBackgroundWork = createBackgroundWork(ble);
  const manager = new SessionManager(ble, store, ADAPTERS, holdBackgroundWork, undefined, (m) => console.log(`[ble] ${m}`));
  const bridge = new BridgeClient(store, credentials, holdBackgroundWork);
  const ota = Updates.updateId && !Updates.isEmbeddedLaunch ? Updates.updateId : 'embedded';

  return {
    store,
    manager,
    bridge,
    updateLabel: updateLabel(),
    createCapture: (deviceId: string, advertisement: CaptureAdvertisement) => {
      const session = new CaptureSession(
        ble,
        deviceId,
        advertisement,
        (id) => manager.claim(id),
        {
          app: `${Application.nativeApplicationVersion} (${Application.nativeBuildVersion})`,
          ota,
          ios: String(Platform.Version),
        },
        (text) => digestStringAsync(CryptoDigestAlgorithm.SHA256, text),
      );
      // The file is written as soon as the recording ends, also when the sheet closed.
      const unsubscribe = session.subscribe(() => {
        const { result } = session.getSnapshot();
        if (!result) return;
        unsubscribe();
        try {
          writeCaptureFile(result.document, result.fileName);
        } catch (error) {
          console.warn('capture file:', error);
        }
      });
      return session;
    },
    uploadCapture: platforms.upload ?? ((document: CaptureDocument) => uploadCapture(document)),
    shareCapture: shareCaptureFile,
    async start() {
      // The saved link first, so restored connections can push at once.
      await Promise.all([store.load(), bridge.refresh()]);
      await manager.start();
      // The Keychain is closed until the first unlock; read it again on foreground.
      AppState.addEventListener('change', (state) => {
        if (state === 'active') void bridge.refresh();
      });
    },
  };
}

export type Services = ReturnType<typeof createServices>;
