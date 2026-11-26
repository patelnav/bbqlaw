// Wires the engine to the native modules. One instance per JS runtime.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createNativeBle } from '../modules/bbq-ble';
import { ADAPTERS } from './adapters';
import { createBackgroundWork } from './engine/backgroundWork';
import { SessionManager } from './engine/sessionManager';
import { expoNotifier, setUpNotifications } from './state/expoNotifier';
import { ProbeStore } from './state/store';

export function createServices() {
  setUpNotifications();
  const ble = createNativeBle();
  const store = new ProbeStore(AsyncStorage, expoNotifier);
  const holdBackgroundWork = createBackgroundWork(ble);
  const manager = new SessionManager(ble, store, ADAPTERS, holdBackgroundWork, undefined, (m) => console.log(`[ble] ${m}`));
  return { ble, store, manager, holdBackgroundWork };
}
