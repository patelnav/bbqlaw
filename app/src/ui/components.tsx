// UI primitives. Flat surfaces, hairline borders.
import { useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator, PanResponder, Pressable, ScrollView, Text, View, type StyleProp, type ViewStyle,
} from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { font, radius, useColors, type Colors } from '../theme/tokens';
import { Icon, type IconName } from './icons';

export function PrimaryButton({ title, icon, kind = 'primary', fullWidth = false, disabled = false, busy = false, onPress }: {
  title: string;
  icon?: IconName;
  kind?: 'primary' | 'bordered' | 'ghost' | 'danger';
  fullWidth?: boolean;
  disabled?: boolean;
  busy?: boolean;
  onPress: () => void;
}) {
  const c = useColors();
  const foreground = { primary: c.white, bordered: c.fg1, ghost: c.ember, danger: c.danger }[kind];
  const background = { primary: c.ember, bordered: c.surface, ghost: 'transparent', danger: 'transparent' }[kind];
  const border = kind === 'bordered' ? c.lineStrong : kind === 'danger' ? c.danger : undefined;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9,
        alignSelf: fullWidth ? 'stretch' : 'center',
        paddingHorizontal: 22, paddingVertical: 15,
        borderRadius: radius.md, borderCurve: 'continuous', backgroundColor: background,
        borderWidth: border ? 1.5 : 0, borderColor: border,
        opacity: disabled ? 0.4 : 1, transform: [{ scale: pressed ? 0.97 : 1 }],
      })}
    >
      {busy ? <ActivityIndicator color={foreground} /> : icon ? <Icon name={icon} size={19} color={foreground} weight={2.4} /> : null}
      <Text style={{ ...font.ui(17, '700'), color: foreground }}>{title}</Text>
    </Pressable>
  );
}

export function SegmentedControl({ options, selection, onSelect }: {
  options: string[]; selection: string; onSelect: (option: string) => void;
}) {
  const c = useColors();
  return (
    <View style={{ flexDirection: 'row', gap: 2, padding: 3, backgroundColor: c.bgSunken, borderRadius: radius.sm }}>
      {options.map((option) => (
        <Pressable
          key={option}
          accessibilityRole="button"
          accessibilityState={{ selected: option === selection }}
          onPress={() => onSelect(option)}
          style={{ paddingHorizontal: 13, paddingVertical: 6, borderRadius: 7, backgroundColor: option === selection ? c.surface : 'transparent' }}
        >
          <Text style={{ ...font.ui(14, '700'), color: option === selection ? c.fg1 : c.fg2 }}>{option}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const SLIDER_MIN = 80;
const SLIDER_MAX = 212;
const THUMB = 28;

/** Cold → warm → ember track with a native-looking thumb. Whole °F steps. */
export function TargetSlider({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const c = useColors();
  const [width, setWidth] = useState(0);
  const live = useRef({ width, value, onChange, startX: 0 });
  Object.assign(live.current, { width, value, onChange });
  const clamp = (v: number) => Math.min(SLIDER_MAX, Math.max(SLIDER_MIN, Math.round(v)));
  const update = (x: number) => {
    const s = live.current;
    if (s.width <= THUMB) return;
    const next = clamp(SLIDER_MIN + ((x - THUMB / 2) / (s.width - THUMB)) * (SLIDER_MAX - SLIDER_MIN));
    if (next !== s.value) s.onChange(next);
  };
  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (event) => {
        live.current.startX = event.nativeEvent.locationX;
        update(live.current.startX);
      },
      onPanResponderMove: (_event, gesture) => update(live.current.startX + gesture.dx),
    }),
  ).current;
  const fraction = Math.min(1, Math.max(0, (value - SLIDER_MIN) / (SLIDER_MAX - SLIDER_MIN)));
  const thumbLeft = fraction * Math.max(0, width - THUMB);
  return (
    <View
      {...responder.panHandlers}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel="Target temperature"
      accessibilityValue={{ min: SLIDER_MIN, max: SLIDER_MAX, now: value }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => onChange(clamp(value + (e.nativeEvent.actionName === 'increment' ? 1 : -1)))}
      style={{ height: THUMB }}
    >
      <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, borderRadius: THUMB / 2, backgroundColor: c.bgSunken, overflow: 'hidden' }}>
        <View style={{ width: thumbLeft + THUMB, height: THUMB, borderRadius: THUMB / 2, overflow: 'hidden' }}>
          <Svg width={thumbLeft + THUMB} height={THUMB}>
            <Defs>
              <LinearGradient id="ramp" x1="0" y1="0" x2="1" y2="0">
                <Stop offset="0" stopColor={c.tempCold} />
                <Stop offset="0.5" stopColor={c.tempWarm} />
                <Stop offset="1" stopColor={c.ember} />
              </LinearGradient>
            </Defs>
            <Rect width={thumbLeft + THUMB} height={THUMB} fill="url(#ramp)" />
          </Svg>
        </View>
      </View>
      <View
        pointerEvents="none"
        style={{
          position: 'absolute', left: thumbLeft + 1, top: 1, width: THUMB - 2, height: THUMB - 2,
          borderRadius: THUMB / 2, backgroundColor: c.white, borderWidth: 0.5, borderColor: 'rgba(0,0,0,0.15)',
        }}
      />
    </View>
  );
}

export function Hairline({ inset = 0 }: { inset?: number }) {
  const c = useColors();
  return <View style={{ height: 1, marginLeft: inset, backgroundColor: c.line }} />;
}

export const card = (c: Colors, r: number = radius.lg): ViewStyle => ({
  backgroundColor: c.surface, borderRadius: r, borderCurve: 'continuous', borderWidth: 1, borderColor: c.line,
});

export function Caps({ children, style }: { children: string; style?: StyleProp<ViewStyle> }) {
  const c = useColors();
  return (
    <View style={style}>
      <Text style={{ ...font.ui(11, '700'), letterSpacing: 0.88, textTransform: 'uppercase', color: c.fg3 }}>{children}</Text>
    </View>
  );
}

/** The content of a sheet: a toolbar button, the title, then a scroll view. */
export function SheetPage({ title, closeLabel, onClose, children }: {
  title: string; closeLabel: string; onClose: () => void; children: ReactNode;
}) {
  const c = useColors();
  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <View style={{ alignSelf: 'center', width: 36, height: 5, marginTop: 5, borderRadius: 3, backgroundColor: c.lineStrong }} />
      <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 6, alignItems: 'flex-start' }}>
        <Pressable accessibilityRole="button" onPress={onClose} hitSlop={10} style={{ paddingHorizontal: 14, paddingVertical: 9, borderRadius: 20, backgroundColor: c.surface }}>
          <Text style={{ ...font.ui(17), color: c.fg1 }}>{closeLabel}</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        <Text accessibilityRole="header" style={{ ...font.display(22), color: c.fg1, paddingTop: 8, paddingBottom: 12 }}>{title}</Text>
        {children}
      </ScrollView>
    </View>
  );
}
