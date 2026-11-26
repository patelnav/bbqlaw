// Phase 1 check: scan, connect, live temperature.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, ScrollView, Text } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { requestNotificationPermission } from '../state/expoNotifier';
import { createServices } from '../services';
import { font, useColors } from '../theme/tokens';

const services = createServices();
const started = services.store
  .load()
  .then(() => services.manager.start())
  .catch((e) => console.error(e));

export function DebugScreen() {
  const c = useColors();
  const state = useSyncExternalStore(services.store.subscribe, services.store.getSnapshot);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    started.then(() => setReady(true));
    requestNotificationPermission();
  }, []);

  const text = { ...font.ui(15), color: c.fg1 };
  const button = (label: string, onPress: () => void, key?: string) => (
    <Pressable key={key ?? label} onPress={onPress} style={{ padding: 14, borderRadius: 13, backgroundColor: c.surface }}>
      <Text style={{ ...font.ui(16, '700'), color: c.ember }}>{label}</Text>
    </Pressable>
  );

  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }}>
        <ScrollView contentContainerStyle={{ padding: 20, gap: 10 }}>
          <Text style={{ ...font.display(24), color: c.fg1 }}>BBQlaw debug</Text>
          <Text style={text}>
            {ready ? '' : 'Starting… '}
            {state.bluetoothOff ? 'Bluetooth off' : state.scanning ? 'Scanning…' : 'Ready'}
          </Text>
          {state.lastError ? <Text style={{ ...text, color: c.danger }}>{state.lastError}</Text> : null}
          {state.probes.map((p) => (
            <Pressable key={p.id} onLongPress={() => services.manager.removeProbe(p.id)}>
              <Text style={{ ...font.display(64), color: c.ember }}>{p.tempF === null ? '—' : `${p.tempF.toFixed(1)}°F`}</Text>
              <Text style={text}>
                {p.name} · {p.connection} · {p.authState} · {p.mode} · base {p.baseBattery ?? '—'} probe {p.probeBattery ?? '—'}
              </Text>
              <Text style={{ ...text, color: c.fg3 }}>Long-press to remove</Text>
            </Pressable>
          ))}
          {button(state.scanning ? 'Stop scan' : 'Scan', () =>
            state.scanning ? services.manager.stopScan() : services.manager.startScan(),
          )}
          {state.discovered.map((d) =>
            button(`${d.name} · ${d.rssi} dBm · ${d.adapter?.name ?? 'unsupported'}`, () => services.manager.connect(d), d.id),
          )}
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
