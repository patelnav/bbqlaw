import { useEffect } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import type { DiscoveredDevice } from '../state/store';
import { font, radius, useColors } from '../theme/tokens';
import { Caps, SheetPage } from './components';

export function ScannerSheet({ discovered, onScan, onConnect, onCapture, onClose }: {
  discovered: DiscoveredDevice[];
  onScan: () => void;
  onConnect: (device: DiscoveredDevice) => void;
  onCapture: (device: DiscoveredDevice) => void;
  onClose: () => void;
}) {
  const c = useColors();
  useEffect(onScan, []);
  const supported = discovered.filter((d) => d.adapter !== null);
  const others = discovered.filter((d) => d.adapter === null && d.advertisedName !== null && d.advertisedName !== '');

  const row = (device: DiscoveredDevice, onPress: () => void) => (
    <Pressable key={device.id} accessibilityRole="button" onPress={onPress}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 14, backgroundColor: c.surface2, borderRadius: radius.md, borderWidth: 1, borderColor: c.line }}>
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={{ ...font.ui(16, '700'), color: c.fg1 }}>{device.name}</Text>
        {device.adapter ? <Text style={{ ...font.ui(12, '600'), color: c.ember }}>{device.adapter.name}</Text> : null}
      </View>
      <Text style={{ ...font.mono(13), color: c.fg3 }}>{device.rssi} dBm</Text>
    </Pressable>
  );

  return (
    <SheetPage title="Thermometers" closeLabel="Cancel" onClose={onClose}>
      <View style={{ gap: 9 }}>
        {supported.length > 0 ? <Caps style={{ paddingHorizontal: 4 }}>Supported</Caps> : null}
        {supported.map((d) => row(d, () => onConnect(d)))}
        {others.length > 0 ? <Caps style={{ paddingHorizontal: 4, paddingTop: 12 }}>Other Bluetooth devices</Caps> : null}
        {others.map((d) => row(d, () => onCapture(d)))}
        <View style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 9, paddingVertical: 10 }}>
          <ActivityIndicator />
          <Text style={{ ...font.ui(13, '500'), color: c.fg3 }}>Searching…</Text>
        </View>
      </View>
    </SheetPage>
  );
}
