// The monitoring screen: status pill, hero temperature, sparkline, probe rail,
// battery tiles and the target card (AppComponents.swift).
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg';
import {
  colorString, cookLabel, hasTarget, isReached, type Probe,
} from '../state/probe';
import { formatTemp, relativeAge, tempUnit, toGo } from '../state/temperature';
import { font, radius, useColors } from '../theme/tokens';
import { Caps, Hairline, PrimaryButton, TargetSlider, card } from './components';
import { Icon } from './icons';
import type { PillStatus } from './statusPill';

function usePulse(active: boolean, duration: number, back: boolean) {
  const value = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!active) {
      value.setValue(0);
      return;
    }
    const step = (toValue: number) =>
      Animated.timing(value, { toValue, duration, easing: Easing.inOut(Easing.ease), useNativeDriver: true });
    const animation = Animated.loop(back ? Animated.sequence([step(1), step(0)]) : step(1));
    animation.start();
    return () => animation.stop();
  }, [active, back, duration, value]);
  return value;
}

export function StatusPill({ status }: { status: PillStatus }) {
  const c = useColors();
  const color = { live: c.ember, idle: c.statusIdle, danger: c.danger }[status.tone];
  const background = { live: c.emberTint, idle: c.slateTint, danger: c.dangerTint }[status.tone];
  const pulse = usePulse(status.pulse, 1600, true);
  return (
    <View style={{ alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 15, paddingVertical: 8, borderRadius: 100, backgroundColor: background }}>
      <Animated.View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color, opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 0.35] }) }} />
      <Text style={{ ...font.ui(13.5, '600'), color }}>{status.label}</Text>
    </View>
  );
}

/** Speaks up only when the feed goes quiet. */
export function FreshnessLine({ lastReadingAt }: { lastReadingAt: number | null }) {
  const c = useColors();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (lastReadingAt === null || now - lastReadingAt < 8000) return null;
  return (
    <View style={{ flexDirection: 'row', alignSelf: 'center', alignItems: 'center', gap: 5, marginTop: 3 }}>
      <Icon name="warning" size={12} color={c.warning} />
      <Text style={{ ...font.ui(11.5, '600'), color: c.warning }}>Last reading {relativeAge(lastReadingAt, now)}</Text>
    </View>
  );
}

function TickGauge({ temp, target }: { temp: number; target: number }) {
  const c = useColors();
  const start = 80;
  const progress = Math.max(0, Math.min(1, (temp - start) / (target - start)));
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 3, marginTop: 22 }}>
      {Array.from({ length: 30 }, (_, i) => {
        const at = i / 29;
        const filled = at <= progress;
        const color = !filled ? c.lineStrong : at < 0.45 ? c.tempCool : at < 0.8 ? c.tempWarm : c.ember;
        return <View key={i} style={{ width: 2, height: i % 5 === 0 ? 22 : 13, borderRadius: 1, backgroundColor: color, opacity: filled ? 1 : 0.55 }} />;
      })}
    </View>
  );
}

export function HeroTemp({ probe, celsius }: { probe: Probe; celsius: boolean }) {
  const c = useColors();
  const reached = isReached(probe);
  const shown = formatTemp(reached ? probe.targetF : probe.tempF, celsius);
  const docked = probe.mode === 'docked';
  const connected = probe.connection === 'connected';
  const ambient = probe.capabilities.includes('ambient') && probe.ambientF !== null ? probe.ambientF : null;
  return (
    <View style={{ alignItems: 'center', gap: 4, paddingVertical: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 2 }}>
        <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: colorString(probe.colorHex) }} />
        <Text style={{ ...font.ui(13, '700'), letterSpacing: 0.78, color: c.fg2 }}>{probe.name.toUpperCase()}</Text>
      </View>
      {probe.mode === 'live' ? (
        <>
          {reached ? <Icon name="sealCheck" size={32} color={c.ember} /> : null}
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 2 }}>
            <Text numberOfLines={1} adjustsFontSizeToFit style={{ ...font.display(96), lineHeight: 114, fontVariant: ['tabular-nums'], color: hasTarget(probe) ? c.ember : c.fg1 }}>
              {shown}
            </Text>
            <Text style={{ ...font.display(30, '700'), color: c.fg3, marginTop: 14 }}>{tempUnit(celsius)}</Text>
          </View>
          {ambient !== null ? (
            <Text style={{ ...font.ui(14, '600'), color: c.fg2 }}>Ambient {formatTemp(ambient, celsius)}°</Text>
          ) : null}
          {!hasTarget(probe) ? (
            <Text style={{ ...font.ui(14, '600'), color: c.fg3, marginTop: 14 }}>
              {probe.alarmEnabled ? 'No target set' : 'Watch only · no alarms'}
            </Text>
          ) : reached ? (
            <Text style={{ ...font.display(21), color: c.ember, marginTop: 6 }}>Target reached</Text>
          ) : probe.tempF !== null && probe.targetF !== null ? (
            <>
              <TickGauge temp={probe.tempF} target={probe.targetF} />
              <Text style={{ ...font.mono(12.5, '600'), color: c.fg3, marginTop: 13 }}>
                TARGET {formatTemp(probe.targetF, celsius)}{tempUnit(celsius)} · {toGo(probe.tempF, probe.targetF, celsius)}° TO GO
              </Text>
            </>
          ) : null}
        </>
      ) : (
        <>
          <View style={{ width: 96, height: 96, borderRadius: 48, marginTop: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: c.slateTint }}>
            <Icon name={docked ? 'plug' : 'thermometer'} size={48} color={c.statusIdle} />
          </View>
          <Text style={{ ...font.display(26), color: c.fg2 }}>{docked ? 'Docked' : connected ? 'No reading' : 'No probe'}</Text>
          <Text style={{ ...font.ui(14, '500'), color: c.fg3, textAlign: 'center' }}>
            {docked ? 'Probe in the base / charging' : connected ? 'Take the probe out to read' : 'Not connected'}
          </Text>
        </>
      )}
    </View>
  );
}

const SPARK_HEIGHT = 46;

export function Sparkline({ samples, color }: { samples: number[]; color: string }) {
  const [width, setWidth] = useState(0);
  const pulse = usePulse(true, 1200, false);
  const low = Math.min(...samples);
  const range = Math.max(1, Math.max(...samples) - low);
  const points = samples.map((v, i) => ({
    x: (width * i) / (samples.length - 1),
    y: 4 + (SPARK_HEIGHT - 8) * (1 - (v - low) / range),
  }));
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join('');
  const head = points[points.length - 1]!;
  return (
    <View
      style={{ height: SPARK_HEIGHT, marginHorizontal: 4 }}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      accessibilityElementsHidden
    >
      {width > 0 && samples.length >= 2 ? (
        <>
          <Svg width={width} height={SPARK_HEIGHT}>
            <Defs>
              <LinearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={color} stopOpacity={0.16} />
                <Stop offset="1" stopColor={color} stopOpacity={0} />
              </LinearGradient>
            </Defs>
            <Path d={`${line}L${head.x} ${SPARK_HEIGHT}L0 ${SPARK_HEIGHT}z`} fill="url(#fill)" />
            <Path d={line} stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </Svg>
          <Animated.View
            style={{
              position: 'absolute', left: head.x - 8, top: head.y - 8, width: 16, height: 16, borderRadius: 8, backgroundColor: color,
              opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.2, 0] }),
              transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }) }],
            }}
          />
          <View style={{ position: 'absolute', left: head.x - 3, top: head.y - 3, width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
        </>
      ) : null}
    </View>
  );
}

export function ProbeRail({ probes, activeId, celsius, onSelect, onAdd }: {
  probes: Probe[]; activeId: string; celsius: boolean; onSelect: (id: string) => void; onAdd: () => void;
}) {
  const c = useColors();
  const chip = { flexDirection: 'row' as const, alignItems: 'center' as const, borderRadius: 100, borderWidth: 1.5, paddingVertical: 9 };
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 8, paddingHorizontal: 2, paddingVertical: 4 }}>
      {probes.map((p) => {
        const active = p.id === activeId;
        const color = colorString(p.colorHex);
        return (
          <Pressable key={p.id} accessibilityRole="button" accessibilityState={{ selected: active }} onPress={() => onSelect(p.id)}
            style={[chip, { gap: 8, paddingHorizontal: 14, backgroundColor: active ? c.surface : 'transparent', borderColor: active ? color : c.lineStrong }]}>
            <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: color }} />
            <Text style={{ ...font.ui(14, '700'), color: c.fg1 }}>{p.name}</Text>
            <Text style={{ ...font.display(14), color: isReached(p) ? c.ember : active ? color : c.fg2 }}>
              {p.mode === 'docked' ? '—' : `${formatTemp(p.tempF, celsius)}°`}
            </Text>
          </Pressable>
        );
      })}
      <Pressable accessibilityRole="button" accessibilityLabel="Add device" onPress={onAdd}
        style={[chip, { gap: 5, paddingHorizontal: 15, borderStyle: 'dashed', borderColor: c.lineStrong }]}>
        <Icon name="plus" size={15} color={c.fg3} weight={2.8} />
        <Text style={{ ...font.ui(14, '700'), color: c.fg2 }}>Add</Text>
      </Pressable>
    </ScrollView>
  );
}

export function BatteryTiles({ probe }: { probe: Probe }) {
  const c = useColors();
  const tile = (label: string, percent: number | null, charging: boolean) => (
    <View style={[card(c, radius.md), { flex: 1, gap: 4, paddingHorizontal: 15, paddingVertical: 13 }]}>
      <Caps>{label}</Caps>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name={charging ? 'batteryBolt' : 'battery'} size={20} color={charging ? c.ember : c.fg2} />
        <Text style={{ ...font.display(19), color: c.fg1 }}>{percent === null ? '—' : `${Math.round(percent)}%`}</Text>
      </View>
    </View>
  );
  return (
    <View style={{ flexDirection: 'row', gap: 11 }}>
      {tile('Probe', probe.probeBattery, false)}
      {tile('Base', probe.baseBattery, probe.mode === 'docked')}
    </View>
  );
}

function NameRow({ probe, onRename }: { probe: Probe; onRename: (id: string, name: string) => void }) {
  const c = useColors();
  const [draft, setDraft] = useState(probe.name);
  const latest = useRef({ draft, probe, onRename });
  latest.current = { draft, probe, onRename };
  useEffect(() => setDraft(probe.name), [probe.name]);
  const commit = () => {
    const { draft: text, probe: p, onRename: rename } = latest.current;
    const trimmed = text.trim();
    if (trimmed === '' || trimmed === p.name) setDraft(p.name);
    else rename(p.id, trimmed);
  };
  useEffect(() => commit, []); // also commit when the row goes away
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 13 }}>
      <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: colorString(probe.colorHex) }} />
      <TextInput value={draft} onChangeText={setDraft} onBlur={commit} maxLength={24} returnKeyType="done"
        placeholder="Name this probe" placeholderTextColor={c.fg3} accessibilityLabel="Probe name"
        style={{ ...font.display(18), flex: 1, padding: 0, color: c.fg1 }} />
      <Icon name="pencil" size={16} color={c.fg3} />
    </View>
  );
}

export function TargetCard({ probe, celsius, canRemove, onRename, onAlarmEnabled, onTarget, onOpenMeat, onRemove }: {
  probe: Probe;
  celsius: boolean;
  canRemove: boolean;
  onRename: (id: string, name: string) => void;
  onAlarmEnabled: (enabled: boolean) => void;
  onTarget: (targetF: number) => void;
  onOpenMeat: () => void;
  onRemove: () => void;
}) {
  const c = useColors();
  const reached = isReached(probe);
  const deviceAlarm = probe.capabilities.includes('deviceAlarm');
  return (
    <View style={card(c)}>
      <NameRow key={probe.id} probe={probe} onRename={onRename} />
      <Hairline />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 18, paddingVertical: 14 }}>
        <View style={{ flex: 1, gap: 3 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
            <Icon name="bellSlash" size={16} color={c.fg1} />
            <Text style={{ ...font.ui(15, '600'), color: c.fg1 }}>Watch only</Text>
          </View>
          <Text style={{ ...font.ui(12), color: c.fg3 }}>
            {deviceAlarm ? 'No app alerts. Clears the base alarm and mutes its buzzer when connected.' : 'No app alerts.'}
          </Text>
        </View>
        <Switch testID="watchOnlyToggle" accessibilityLabel="Watch only" value={!probe.alarmEnabled}
          onValueChange={(watchOnly) => onAlarmEnabled(!watchOnly)} trackColor={{ true: c.ember }} />
      </View>
      <Hairline />
      {hasTarget(probe) ? (
        <>
          <Pressable accessibilityRole="button" onPress={onOpenMeat} style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 13 }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Caps>Cooking</Caps>
              <Text style={{ ...font.ui(16, '700'), color: c.fg1 }}>{cookLabel(probe)}</Text>
            </View>
            <Icon name="chevronRight" size={16} color={c.fg3} weight={2.4} />
          </Pressable>
          <Hairline />
          <View style={{ gap: 11, paddingHorizontal: 18, paddingVertical: 16 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={{ ...font.ui(15, '600'), color: c.fg2 }}>Target</Text>
              <Text style={{ ...font.display(17), color: c.fg1 }}>{formatTemp(probe.targetF, celsius)}{tempUnit(celsius)}</Text>
            </View>
            <TargetSlider value={probe.targetF ?? 165} onChange={onTarget} />
          </View>
          <Hairline />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 18, paddingVertical: 14 }}>
            <Icon name={reached ? 'sealCheck' : 'bell'} size={19} color={reached ? c.ember : c.fg3} />
            <Text style={{ ...font.ui(14, '500'), flex: 1, color: reached ? c.ember : c.fg2 }}>
              {reached ? "Target reached — you've been alerted" : `Alerts you at ${formatTemp(probe.targetF, celsius)}${tempUnit(celsius)}`}
            </Text>
          </View>
        </>
      ) : (
        <View style={{ gap: 9, paddingHorizontal: 16, paddingVertical: 14 }}>
          <PrimaryButton title={probe.alarmEnabled ? 'Set a target' : 'Set up an alarm'} icon="bell" kind="bordered" fullWidth
            onPress={() => {
              onAlarmEnabled(true);
              onOpenMeat();
            }} />
          <Text style={{ ...font.ui(13), color: c.fg3, textAlign: 'center' }}>
            {probe.alarmEnabled
              ? 'Watching the temperature. Set a target to get alerted.'
              : 'Temperature and graph stay live. Turn off Watch only to restore your saved target.'}
          </Text>
        </View>
      )}
      {canRemove ? (
        <>
          <Hairline />
          <Pressable accessibilityRole="button" onPress={onRemove} style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6, paddingVertical: 14 }}>
            <Icon name="xmark" size={14} color={c.danger} weight={3} />
            <Text style={{ ...font.ui(14, '700'), color: c.danger }}>Remove this probe</Text>
          </Pressable>
        </>
      ) : null}
    </View>
  );
}
