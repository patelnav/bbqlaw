import { ActivityIndicator, Text, View } from 'react-native';
import { font, useColors } from '../theme/tokens';
import { PrimaryButton } from './components';
import { Icon } from './icons';

export function AddDeviceScreen({ pairingLabel, bluetoothOff, onScan }: {
  pairingLabel: string | null; bluetoothOff: boolean; onScan: () => void;
}) {
  const c = useColors();
  if (pairingLabel !== null) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 18, paddingHorizontal: 22 }}>
        <ActivityIndicator size="large" color={c.ember} />
        <Text style={{ ...font.display(22), color: c.fg1 }}>{pairingLabel}</Text>
        <Text style={{ ...font.ui(14), color: c.fg3, textAlign: 'center', maxWidth: 240 }}>
          Keep the probe out of the base and nearby while we connect.
        </Text>
      </View>
    );
  }
  return (
    <View style={{ flex: 1, paddingHorizontal: 26 }}>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 }}>
        <View style={{ width: 92, height: 92, borderRadius: 22, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center', backgroundColor: c.emberTint }}>
          <Icon name="thermometer" size={48} color={c.ember} />
        </View>
        <Text style={{ ...font.display(28), color: c.fg1, textAlign: 'center' }}>Add your thermometer</Text>
        <Text style={{ ...font.ui(15), color: c.fg2, textAlign: 'center', maxWidth: 290 }}>
          Take the probe out of the base so it's measuring, then scan. No vendor app, no account.
        </Text>
      </View>
      <View style={{ gap: 10, paddingBottom: 8 }}>
        <PrimaryButton title="Scan for device" icon="search" fullWidth disabled={bluetoothOff} onPress={onScan} />
        {bluetoothOff ? (
          <Text style={{ ...font.ui(13, '500'), color: c.danger, textAlign: 'center' }}>Turn on Bluetooth to scan.</Text>
        ) : null}
      </View>
    </View>
  );
}
