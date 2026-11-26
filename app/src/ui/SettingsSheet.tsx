import * as Clipboard from 'expo-clipboard';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import type { BridgeSnapshot } from '../bridge/client';
import { shouldMuteBaseBuzzer, colorString, type Probe } from '../state/probe';
import { formatTemp, tempUnit } from '../state/temperature';
import { font, radius, useColors } from '../theme/tokens';
import { Caps, Hairline, PrimaryButton, SegmentedControl, SheetPage, card } from './components';
import { Icon } from './icons';

export function SettingsSheet({ probes, activeId, celsius, bridge, updateLabel, onUnits, onSelectProbe, onAddDevice, onRemoveProbe, onBaseMuted, onPair, onUnlink, onClose }: {
  probes: Probe[];
  activeId: string | undefined;
  celsius: boolean;
  bridge: BridgeSnapshot;
  updateLabel: string;
  onUnits: (celsius: boolean) => void;
  onSelectProbe: (id: string) => void;
  onAddDevice: () => void;
  onRemoveProbe: (id: string) => void;
  onBaseMuted: (id: string, muted: boolean) => void;
  onPair: () => Promise<string | null>;
  onUnlink: () => void;
  onClose: () => void;
}) {
  const c = useColors();
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (copied === null) return;
    const timer = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async (url: string, message: string) => {
    await Clipboard.setStringAsync(url);
    setCopied(message);
  };

  const deviceRow = (p: Probe) => (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16 }}>
      <Pressable accessibilityRole="button" onPress={() => onSelectProbe(p.id)} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 15 }}>
        <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: colorString(p.colorHex) }} />
        <Text numberOfLines={1} style={{ ...font.ui(16, '600'), flex: 1, color: c.fg1 }}>{p.name}</Text>
        <Text style={{ ...font.ui(15, '600'), color: c.fg3 }}>
          {p.mode === 'docked' ? 'Docked' : `${formatTemp(p.tempF, celsius)}${tempUnit(celsius)}`}
        </Text>
        {p.id === activeId ? <Icon name="sealCheck" size={18} color={c.ember} /> : null}
      </Pressable>
      {p.capabilities.includes('deviceAlarm') ? (
        <Pressable accessibilityRole="button" disabled={!p.alarmEnabled} onPress={() => onBaseMuted(p.id, !p.baseMuted)}
          accessibilityLabel={!p.alarmEnabled ? 'Base buzzer muted in Watch only' : `${p.baseMuted ? 'Unmute' : 'Mute'} base buzzer for ${p.name}`}
          style={{ paddingLeft: 12, paddingVertical: 15, opacity: p.alarmEnabled ? 1 : 0.5 }}>
          <Icon name={shouldMuteBaseBuzzer(p) ? 'speakerSlash' : 'speaker'} size={18} color={shouldMuteBaseBuzzer(p) ? c.ember : c.fg3} />
        </Pressable>
      ) : null}
      <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${p.name}`} onPress={() => onRemoveProbe(p.id)} style={{ paddingLeft: 12, paddingVertical: 15 }}>
        <Icon name="trash" size={18} color={c.danger} />
      </Pressable>
    </View>
  );

  const note = (text: string, color: string) => (
    <Text style={{ ...font.ui(13, '500'), color, paddingHorizontal: 6, paddingTop: 8 }}>{text}</Text>
  );

  return (
    <SheetPage title="Settings" closeLabel="Done" onClose={onClose}>
      <Caps style={{ paddingHorizontal: 4, paddingBottom: 8 }}>Units</Caps>
      <View style={[card(c, radius.md), { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10 }]}>
        <Text style={{ ...font.ui(16, '600'), color: c.fg1 }}>Temperature</Text>
        <SegmentedControl options={['°F', '°C']} selection={celsius ? '°C' : '°F'} onSelect={(o) => onUnits(o === '°C')} />
      </View>

      <Caps style={{ paddingHorizontal: 4, paddingBottom: 8, paddingTop: 22 }}>Devices</Caps>
      <View style={card(c, radius.md)}>
        {probes.map((p, i) => (
          <View key={p.id}>
            {i > 0 ? <Hairline inset={16} /> : null}
            {deviceRow(p)}
          </View>
        ))}
        {probes.length > 0 ? <Hairline inset={16} /> : null}
        <Pressable accessibilityRole="button" onPress={onAddDevice} style={{ flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 16, paddingVertical: 15 }}>
          <Icon name="plus" size={18} color={c.ember} weight={3} />
          <Text style={{ ...font.ui(16, '600'), color: c.ember }}>Add device</Text>
        </Pressable>
      </View>

      <Caps style={{ paddingHorizontal: 4, paddingBottom: 8, paddingTop: 22 }}>Automations</Caps>
      <View style={card(c, radius.md)}>
        {bridge.isLinked && bridge.shareURL ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16 }}>
            <Pressable accessibilityRole="button" accessibilityLabel="Copy feed link" onPress={() => copy(bridge.shareURL!, 'Copied ✓')} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 15 }}>
              <Text numberOfLines={1} ellipsizeMode="middle" style={{ ...font.mono(14), flex: 1, color: c.fg1 }}>{bridge.shareURL}</Text>
              <Icon name="copy" size={15} color={c.fg3} />
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Unlink OpenClaw" onPress={onUnlink} style={{ paddingLeft: 14, paddingVertical: 15 }}>
              <Icon name="trash" size={18} color={c.danger} />
            </Pressable>
          </View>
        ) : bridge.linking ? (
          <View style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 9, paddingVertical: 15 }}>
            <ActivityIndicator />
            <Text style={{ ...font.ui(15, '600'), color: c.fg3 }}>Linking…</Text>
          </View>
        ) : (
          <View style={{ paddingHorizontal: 16, paddingVertical: 10 }}>
            <PrimaryButton title="Link to OpenClaw & copy" icon="link" fullWidth onPress={async () => {
              const url = await onPair();
              if (url) await copy(url, 'Link copied to clipboard ✓');
            }} />
          </View>
        )}
      </View>
      {copied ? note(copied, c.ember) : null}
      {bridge.lastError ? note(bridge.lastError, c.danger) : null}
      <Text style={{ ...font.ui(13), color: c.fg3, paddingHorizontal: 6, paddingTop: 10 }}>
        Forward live readings so your agent can watch the cook and message someone when it's done. Your phone stays the Bluetooth bridge.
      </Text>
      <Text style={{ ...font.mono(11), color: c.fg3, textAlign: 'center', paddingTop: 28 }}>{updateLabel}</Text>
    </SheetPage>
  );
}
