// The kettle-damper mark (the rotated "Q") and the BB◉law wordmark.
import { Text, View } from 'react-native';
import Svg, { Defs, G, LinearGradient, Path, Stop } from 'react-native-svg';
import { font, useColors } from '../theme/tokens';

const circle = (cx: number, cy: number, r: number) =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`;
const MARK = [
  circle(60, 56, 44),
  circle(45, 41, 9.5),
  circle(75, 41, 9.5),
  circle(45, 71, 9.5),
  circle(75, 71, 9.5),
].join('');
const TAB = 'M52 92L68 92L72 112Q72 115 69 115L51 115Q48 115 48 112z';

export function DamperMark({ size = 40 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 120 120">
      <Defs>
        <LinearGradient id="ember" x1="0.1" y1="0.05" x2="0.9" y2="1">
          <Stop offset="0" stopColor="#F7B23E" />
          <Stop offset="0.5" stopColor="#E3611F" />
          <Stop offset="1" stopColor="#C2410C" />
        </LinearGradient>
      </Defs>
      <G transform="rotate(-45 60 60)">
        <Path d={MARK} fill="url(#ember)" fillRule="evenodd" />
        <Path d={TAB} fill="url(#ember)" />
      </G>
    </Svg>
  );
}

export function Logo({ size = 21 }: { size?: number }) {
  const c = useColors();
  const text = { ...font.display(size), letterSpacing: -0.03 * size, color: c.fg1 };
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }} accessible accessibilityLabel="BBQlaw">
      <Text style={text}>BB</Text>
      <View style={{ marginHorizontal: -size * 0.05 }}>
        <DamperMark size={size * 1.06} />
      </View>
      <Text style={[text, { color: c.ember }]}>law</Text>
    </View>
  );
}
