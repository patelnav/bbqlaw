import { useEffect, useState } from 'react';
import { Settings } from 'react-native';
import { createNativeBle } from '../modules/bbq-ble';
import { secureCredentials } from './bridge/secureCredentials';
import { createServices, type Services } from './services';
import { requestNotificationPermission, setUpNotifications } from './state/expoNotifier';
import { watchForUpdates } from './state/otaUpdates';
import { Root, type Sheet } from './ui/Root';

function boot(): { services: Services; ready: Promise<Sheet | null> } {
  setUpNotifications();
  if (__DEV__) {
    // A launch argument, for example `-bbqDemo monitoring`.
    const scene: unknown = Settings.get('bbqDemo');
    if (typeof scene === 'string') {
      const { createDemo } = require('./demo/demo') as typeof import('./demo/demo');
      const demo = createDemo(scene);
      return { services: demo.services, ready: demo.services.start().then(demo.run) };
    }
  }
  const services = createServices({ ble: createNativeBle(), credentials: secureCredentials });
  // Start Bluetooth at module load, not when a view mounts: iOS can run JS without one.
  const ready = services.start().then(
    () => null,
    (error) => {
      console.error(error);
      return null;
    },
  );
  void requestNotificationPermission();
  watchForUpdates();
  return { services, ready };
}

const app = boot();

export function App() {
  const [started, setStarted] = useState<{ sheet: Sheet | null } | null>(null);
  useEffect(() => {
    app.ready.then((sheet) => setStarted({ sheet }), console.error);
  }, []);
  return started ? <Root services={app.services} initialSheet={started.sheet} /> : null;
}
